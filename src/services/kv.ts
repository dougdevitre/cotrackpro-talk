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

import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ service: "kv" });

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
}

// ── In-memory backend ───────────────────────────────────────────────────────
//
// Per-process Map with explicit expiry. A lazy sweep (on read) removes
// expired entries; there's no background timer so the store has zero
// overhead when unused.

type Entry = { value: string; expiresAt: number | null };

class MemoryKv implements KvStore {
  private store = new Map<string, Entry>();

  private isExpired(entry: Entry): boolean {
    return entry.expiresAt !== null && Date.now() >= entry.expiresAt;
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
    return next;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
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
}

// ── Backend selection ───────────────────────────────────────────────────────

function resolveBackend(): KvStore {
  const requested = env.kvBackend;
  const url = env.kvUrl;
  const token = env.kvToken;

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
