/**
 * services/kv.ts — Minimal KV store abstraction.
 *
 * Used for cross-instance shared state: rate limit counters,
 * idempotency keys, and similar "small value, short TTL, high read"
 * workloads. NOT used for the call session store — sessions.ts stays
 * in-memory because it's on the audio hot path (see the comment in
 * sessions.ts explaining why).
 *
 * Two backends:
 *
 *   1. memory (default) — single-instance only. A Map with per-key
 *      expiry timestamps. Zero setup, zero external calls.
 *
 *   2. upstash — Upstash Redis via REST. Works on both the Vercel tier
 *      (serverless) and the WS host without adding any npm dependency;
 *      we just use the global fetch(). Vercel KV is API-compatible with
 *      Upstash Redis REST, so this also works with Vercel KV
 *      (set KV_URL/KV_TOKEN to the Vercel KV values).
 *
 * Selected via KV_BACKEND env var. If KV_URL + KV_TOKEN are set,
 * upstash is used automatically; otherwise memory.
 *
 * This abstraction is intentionally minimal — get / set with TTL /
 * incrBy / delete. Add methods only when a caller actually needs one.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ service: "kv" });

/**
 * One step in a pipelined write. Only `incrBy` is supported today
 * because that's all the rate limiter needs; extend as new callers
 * require it. Kept narrow so both backends can implement the
 * semantics precisely rather than fighting a generic command ABI.
 */
export type PipelineOp = {
  op: "incrBy";
  key: string;
  by: number;
  ttlSeconds?: number;
};

export interface KvStore {
  /** Get a string value, or null if missing/expired. */
  get(key: string): Promise<string | null>;
  /**
   * Set a string value. If ttlSeconds is provided, the value expires
   * after that many seconds.
   */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /**
   * Atomically increment an integer-valued key by `by` (default 1) and
   * return the new value. If the key doesn't exist it's created as
   * `by`. If ttlSeconds is provided AND the key was newly created by
   * this call, the TTL is set (existing TTLs are not disturbed).
   */
  incrBy(key: string, by?: number, ttlSeconds?: number): Promise<number>;
  /** Delete a key. No-op if missing. */
  delete(key: string): Promise<void>;
  /**
   * Run a batch of operations as a single unit. Returns the result of
   * each op in the same order — for `incrBy` ops that's the new
   * integer value. Failure modes:
   *
   *   - MemoryKv: atomic by construction (single-threaded JS).
   *   - UpstashKv: ships as one HTTP request to the REST /pipeline
   *     endpoint; Upstash runs the commands sequentially on one
   *     connection. A network-level failure aborts the whole batch,
   *     so callers never see a half-applied state — which is the
   *     point (M-1 in the code review: the old split-call path
   *     could leave the minute counter bumped while the hour
   *     counter remained untouched).
   *
   * Callers should treat a thrown error as a transient failure and
   * fail open if they care about availability.
   */
  pipeline(ops: PipelineOp[]): Promise<number[]>;
}

// ── In-memory backend ───────────────────────────────────────────────────────
//
// Per-process Map with explicit expiry. Expired entries are dropped on
// read (lazy cleanup) AND via an amortized sweep every SWEEP_EVERY_N
// writes. Previously this only cleaned up on read, which meant a caller
// that wrote keys-with-TTL and never read them could grow the Map
// unboundedly. In practice this hasn't bitten because the rate limiter
// is a heavy reader, but the idempotency cache (which reads only on
// retries) could have tripped it. M-5 in
// docs/CODE_REVIEW-vercel-hosting-optimization.md.

type Entry = { value: string; expiresAt: number | null };

/**
 * How often to run the amortized sweep of expired entries. Every Nth
 * write (across set + incrBy) triggers a scan-and-delete pass over
 * the whole Map. 128 is a rough sweet spot: large enough that the
 * per-write cost is negligible, small enough that an unbounded Map
 * can't get very large before being trimmed. Exported for tests.
 */
export const MEMORY_KV_SWEEP_EVERY_N_WRITES = 128;

class MemoryKv implements KvStore {
  private store = new Map<string, Entry>();
  private writeCount = 0;

  private isExpired(entry: Entry): boolean {
    return entry.expiresAt !== null && Date.now() >= entry.expiresAt;
  }

  /**
   * Lazy sweep of expired entries. Called from the write path every
   * SWEEP_EVERY_N writes. O(n) in the size of the Map but amortized
   * to O(1) per write. Safe to call concurrently — we're
   * single-threaded JS, Map iteration during delete is defined
   * behavior.
   */
  private maybeSweep(): void {
    this.writeCount += 1;
    if (this.writeCount % MEMORY_KV_SWEEP_EVERY_N_WRITES !== 0) return;
    this.sweep();
  }

  /**
   * Unconditional sweep of expired entries. Exposed for tests via
   * `_sweepNow` — production code relies on `maybeSweep`.
   */
  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
    this.maybeSweep();
  }

  async incrBy(
    key: string,
    by: number = 1,
    ttlSeconds?: number,
  ): Promise<number> {
    const existing = this.store.get(key);
    const isNew = !existing || this.isExpired(existing);
    const current = isNew ? 0 : parseInt(existing!.value, 10) || 0;
    const next = current + by;
    this.store.set(key, {
      value: String(next),
      // Only set TTL on creation so we match Upstash's INCR + EXPIRE NX
      // semantics (don't bump TTL on subsequent increments).
      expiresAt: isNew && ttlSeconds
        ? Date.now() + ttlSeconds * 1000
        : existing?.expiresAt ?? null,
    });
    this.maybeSweep();
    return next;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async pipeline(ops: PipelineOp[]): Promise<number[]> {
    // In a single-threaded JS process there's no observable
    // concurrency between these calls, so "run each op in turn" is
    // already atomic. No need for fancier machinery.
    const results: number[] = [];
    for (const op of ops) {
      if (op.op === "incrBy") {
        results.push(await this.incrBy(op.key, op.by, op.ttlSeconds));
      }
    }
    return results;
  }

  // ── Test-only helpers ──────────────────────────────────────────
  //
  // Exposed for unit tests so we can force-sweep without having to
  // write 128 entries first, and inspect the internal size without
  // coupling the test to Map implementation details. DO NOT call
  // from production code.

  /** Current entry count (including not-yet-swept expired entries). */
  _sizeForTests(): number {
    return this.store.size;
  }

  /** Force an immediate sweep. */
  _sweepNowForTests(): void {
    this.sweep();
  }

  /** Number of writes observed by this instance. */
  _writeCountForTests(): number {
    return this.writeCount;
  }
}

// ── Upstash Redis REST backend ──────────────────────────────────────────────
//
// Upstash Redis exposes every command as either an HTTP GET or POST
// against /{command}/{arg1}/{arg2}/... with a Bearer token. Vercel KV
// is API-compatible with this, so the same code handles both.
// Reference: https://upstash.com/docs/redis/features/restapi

class UpstashKv implements KvStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  /**
   * Send a single Redis command. Throws on network failure, HTTP
   * non-2xx, or an Upstash `error` field in the JSON body.
   */
  private async call(command: string[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstash ${command[0]} failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) {
      throw new Error(`Upstash ${command[0]} error: ${json.error}`);
    }
    return json.result;
  }

  /**
   * Send multiple Redis commands in one HTTP round-trip via the
   * Upstash `/pipeline` endpoint. Upstash runs the commands
   * sequentially on one connection so partial state is impossible —
   * either every command lands or the whole batch throws.
   *
   * Reference: https://upstash.com/docs/redis/features/restapi#pipeline
   *
   * The pipeline URL is derived from the base URL by appending
   * `/pipeline`. Vercel KV uses the same endpoint layout because
   * it's a drop-in Upstash clone.
   */
  private async callBatch(commands: string[][]): Promise<unknown[]> {
    // `new URL("pipeline", this.url)` would replace the last path
    // segment in some cases; manual concatenation with a trailing
    // slash guarantees we append.
    const base = this.url.endsWith("/") ? this.url : this.url + "/";
    const pipelineUrl = base + "pipeline";

    const res = await fetch(pipelineUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstash pipeline failed: ${res.status} ${text}`);
    }
    const body = (await res.json()) as Array<{
      result?: unknown;
      error?: string;
    }>;
    if (!Array.isArray(body)) {
      throw new Error("Upstash pipeline: expected array response");
    }
    // Upstash returns per-command errors inline. Surface the first
    // one so the caller knows something went wrong.
    for (let i = 0; i < body.length; i++) {
      if (body[i].error) {
        throw new Error(
          `Upstash pipeline[${i}] ${commands[i]?.[0]} error: ${body[i].error}`,
        );
      }
    }
    return body.map((entry) => entry.result);
  }

  async get(key: string): Promise<string | null> {
    const result = await this.call(["GET", key]);
    return result === null || result === undefined ? null : String(result);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const cmd = ttlSeconds
      ? ["SET", key, value, "EX", String(ttlSeconds)]
      : ["SET", key, value];
    await this.call(cmd);
  }

  async incrBy(
    key: string,
    by: number = 1,
    ttlSeconds?: number,
  ): Promise<number> {
    // Pipeline INCRBY + EXPIRE (NX) so the TTL is only set on
    // newly-created keys. We use Upstash's multi-exec endpoint by
    // sending two commands; for simplicity we do them as separate
    // calls — the window is small and the error is self-healing.
    const result = await this.call(["INCRBY", key, String(by)]);
    const next = Number(result);
    if (ttlSeconds && next === by) {
      // First increment in this window → set TTL.
      await this.call(["EXPIRE", key, String(ttlSeconds), "NX"]).catch(
        (err) => {
          // EXPIRE with NX is available on Redis 7+. If the server is
          // older, fall back to an unconditional EXPIRE — we're still
          // within the same window so this is fine.
          log.debug({ err }, "EXPIRE NX failed, falling back to EXPIRE");
          return this.call(["EXPIRE", key, String(ttlSeconds)]);
        },
      );
    }
    return next;
  }

  async delete(key: string): Promise<void> {
    await this.call(["DEL", key]);
  }

  async pipeline(ops: PipelineOp[]): Promise<number[]> {
    if (ops.length === 0) return [];

    // Build a flat command list + remember which entries are
    // INCRBY results (we only return those) vs. EXPIRE bookkeeping.
    // Example for 2 incrBy-with-ttl ops:
    //   [INCRBY k1, EXPIRE k1, INCRBY k2, EXPIRE k2]
    //              ^drop         ^keep     ^drop
    const commands: string[][] = [];
    const resultIndices: number[] = []; // positions in `commands` that
                                        // produce the caller-visible number
    for (const op of ops) {
      if (op.op !== "incrBy") continue;
      resultIndices.push(commands.length);
      commands.push(["INCRBY", op.key, String(op.by)]);
      if (op.ttlSeconds) {
        // Unconditional EXPIRE inside the pipeline: cheaper than
        // EXPIRE NX, and for the rate-limit use case (fixed-window
        // keys that roll over at window boundaries) the overrun is
        // harmless — next window uses a new key, so re-setting the
        // TTL on every write doesn't extend any logical window.
        commands.push(["EXPIRE", op.key, String(op.ttlSeconds)]);
      }
    }

    const raw = await this.callBatch(commands);

    // Extract only the INCRBY positions as numbers.
    return resultIndices.map((i) => {
      const v = raw[i];
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) {
        throw new Error(
          `Upstash pipeline: unexpected INCRBY result at position ${i}: ${String(v)}`,
        );
      }
      return n;
    });
  }
}

// ── DynamoDB backend ────────────────────────────────────────────────────────
//
// AWS-native alternative to Upstash. DynamoDB is HTTP-based (no VPC, unlike
// ElastiCache), so it works from Vercel serverless, and it has native TTL.
// One table, partition key `pk` (String). A key holds EITHER a string value
// (`v`, for idempotency + suppression) OR a counter (`n`, for rate limits) —
// never both in our usage — plus an optional `expireAt` (epoch seconds, the
// DynamoDB TTL attribute).
//
// DynamoDB's TTL sweep is LAZY (can lag up to ~48h), so — exactly like
// MemoryKv — we store an explicit `expireAt` and treat an item whose
// `expireAt` has passed as MISSING on read. That keeps semantics correct
// regardless of when DynamoDB actually deletes the row.
//
// The counter path (`incrBy`) sets the TTL only on the first write via
// `if_not_exists(expireAt, …)`. This is safe because every counter key is
// the rate limiter's time-bucketed key (`rl:<ns>:<client>:<m|h|d>:<bucket>`):
// a new window is always a NEW key, so a lingering expired bucket is never
// re-incremented and can't continue an old count.

export type DynamoKvItem = {
  pk: string;
  v?: string;
  n?: number;
  expireAt?: number;
};

/**
 * The minimal DynamoDB surface DynamoKv needs. Production wraps the AWS
 * SDK DocumentClient; tests inject an in-memory fake so the KV logic
 * (TTL-on-read filtering, counter + first-write-TTL semantics, pipeline
 * ordering) is unit-tested without AWS.
 */
export interface DynamoKvClient {
  getItem(pk: string): Promise<DynamoKvItem | null>;
  putItem(item: DynamoKvItem): Promise<void>;
  /** Atomic `ADD n :by`, setting `expireAt` only if not already set.
   *  Returns the new counter value. */
  addToCounter(pk: string, by: number, expireAt?: number): Promise<number>;
  deleteItem(pk: string): Promise<void>;
}

class DynamoKv implements KvStore {
  constructor(private readonly client: DynamoKvClient) {}

  private nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  private isExpired(item: DynamoKvItem): boolean {
    return item.expireAt !== undefined && this.nowSec() >= item.expireAt;
  }

  async get(key: string): Promise<string | null> {
    const item = await this.client.getItem(key);
    if (!item || this.isExpired(item)) return null;
    if (item.v !== undefined) return item.v;
    if (item.n !== undefined) return String(item.n);
    return null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.client.putItem({
      pk: key,
      v: value,
      expireAt: ttlSeconds ? this.nowSec() + ttlSeconds : undefined,
    });
  }

  async incrBy(key: string, by: number = 1, ttlSeconds?: number): Promise<number> {
    return this.client.addToCounter(
      key,
      by,
      ttlSeconds ? this.nowSec() + ttlSeconds : undefined,
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.deleteItem(key);
  }

  async pipeline(ops: PipelineOp[]): Promise<number[]> {
    // DynamoDB has no values-returning batch, so run the incrBy ops in
    // turn — same semantics as MemoryKv. The rate limiter only ever
    // pipelines 2-3 ops, so the extra round-trips are negligible.
    const results: number[] = [];
    for (const op of ops) {
      if (op.op === "incrBy") {
        results.push(await this.incrBy(op.key, op.by, op.ttlSeconds));
      }
    }
    return results;
  }
}

/** Production DynamoKvClient backed by the AWS SDK DocumentClient. */
function realDynamoKvClient(table: string): DynamoKvClient {
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: env.dynamoRegion,
      maxAttempts: env.dynamoMaxRetries + 1, // AWS counts the initial try
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );

  return {
    async getItem(pk) {
      const out = await doc.send(new GetCommand({ TableName: table, Key: { pk } }));
      return (out.Item as DynamoKvItem | undefined) ?? null;
    },
    async putItem(item) {
      // removeUndefinedValues drops `expireAt` when no TTL was requested.
      await doc.send(new PutCommand({ TableName: table, Item: item }));
    },
    async addToCounter(pk, by, expireAt) {
      const names: Record<string, string> = { "#n": "n" };
      const values: Record<string, number> = { ":by": by };
      let expr = "ADD #n :by";
      if (expireAt !== undefined) {
        expr = "SET expireAt = if_not_exists(expireAt, :e) ADD #n :by";
        values[":e"] = expireAt;
      }
      const out = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk },
          UpdateExpression: expr,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "UPDATED_NEW",
        }),
      );
      return Number((out.Attributes as { n?: number } | undefined)?.n ?? by);
    },
    async deleteItem(pk) {
      await doc.send(new DeleteCommand({ TableName: table, Key: { pk } }));
    },
  };
}

// ── Backend selection ───────────────────────────────────────────────────────

function resolveBackend(): KvStore {
  const requested = env.kvBackend;
  const url = env.kvUrl;
  const token = env.kvToken;

  // Explicit opt-in only — `auto` never picks dynamo (it would require AWS
  // creds + a provisioned table that memory/upstash users don't have).
  if (requested === "dynamo") {
    log.info({ table: env.kvDynamoTable }, "KV backend: dynamo");
    return new DynamoKv(realDynamoKvClient(env.kvDynamoTable));
  }

  if (requested === "upstash" || (requested === "auto" && url && token)) {
    if (!url || !token) {
      log.warn(
        "KV_BACKEND=upstash but KV_URL/KV_TOKEN missing — falling back to memory",
      );
      return new MemoryKv();
    }
    log.info({ url: url.replace(/\/\/.*@/, "//***@") }, "KV backend: upstash");
    return new UpstashKv(url, token);
  }

  log.info("KV backend: memory");
  return new MemoryKv();
}

let _kv: KvStore | null = null;

/** Lazy singleton accessor. The first call picks the backend. */
export function kv(): KvStore {
  if (!_kv) _kv = resolveBackend();
  return _kv;
}

/** Test-only: reset the singleton. Do not call in production code. */
export function _resetKvForTests(): void {
  _kv = null;
}

/**
 * Test-only: inject a custom KV implementation (e.g. a stub that
 * throws, to exercise fail-open behavior). Do not call in production.
 */
export function _setKvForTests(store: KvStore): void {
  _kv = store;
}

/** Test-only: expose MemoryKv for direct unit tests. */
export { MemoryKv as _MemoryKvForTests };

/** Test-only: expose DynamoKv for direct unit tests (drive it with a fake
 *  DynamoKvClient so no AWS is touched). */
export { DynamoKv as _DynamoKvForTests };
