/**
 * core/rateLimit.ts — Fixed-window rate limiter over the KV store.
 *
 * Cross-tier: both the Fastify adapter and the Vercel serverless
 * handler can call this. When KV is backed by Upstash/Vercel KV, the
 * counter is shared across all instances — so N Vercel functions and
 * M Fargate tasks all enforce the same budget. With the default
 * in-memory backend it's per-process, which is still useful as a
 * last-resort local brake.
 *
 * Algorithm: two fixed windows (per-minute + per-hour). Each request
 * does one INCRBY per window. A request is rejected if either counter
 * exceeds its limit. Fixed-window is coarser than true sliding-window
 * but takes one (or two) KV ops instead of N, and bill-protection
 * doesn't need sub-minute precision.
 *
 * A caller is identified by the raw client key string — we don't
 * assume IP, API key, etc. The caller passes whatever dimension makes
 * sense for their use case.
 */

import { kv, type PipelineOp } from "../services/kv.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ core: "rateLimit" });

export type RateLimitWindow = "minute" | "hour";

export type RateLimitResult = {
  /** true = request allowed; false = denied. */
  allowed: boolean;
  /** Which window tripped, if denied. undefined when allowed. */
  limitedBy?: RateLimitWindow;
  /** Unix ms at which the limiting window resets. */
  resetAt?: number;
  /** Current counters for observability. */
  counts: { minute: number; hour: number };
};

export type RateLimitConfig = {
  /** Max requests per 60-second window. Set to 0 to disable. */
  perMinute: number;
  /** Max requests per 3600-second window. Set to 0 to disable. */
  perHour: number;
};

/**
 * Check-and-increment. Call this once per request. Returns whether
 * the request should be allowed and why.
 *
 * On KV errors we FAIL OPEN (log + allow) rather than blocking real
 * traffic. A rate limiter outage shouldn't take down the product.
 *
 * @param clientKey  Stable identifier for the caller (e.g. API key
 *                   hash, IP address, tenant ID). NOT the raw secret.
 * @param namespace  Logical bucket name (e.g. "outbound"). Lets
 *                   different endpoints have independent budgets.
 */
export async function checkRateLimit(
  clientKey: string,
  namespace: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  // Disabled entirely.
  if (config.perMinute <= 0 && config.perHour <= 0) {
    return { allowed: true, counts: { minute: 0, hour: 0 } };
  }

  // Fixed-window bucket keys. Aligning on UTC minute/hour is simpler
  // than tracking per-client window start times and makes counters
  // easy to reason about in Redis.
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60_000);
  const hourBucket = Math.floor(now / 3_600_000);

  const minuteKey = `rl:${namespace}:${clientKey}:m:${minuteBucket}`;
  const hourKey = `rl:${namespace}:${clientKey}:h:${hourBucket}`;

  try {
    // Increment both counters atomically via the KV pipeline. On
    // Upstash this ships as one HTTP request; on MemoryKv it's just
    // sequential in-process calls (already atomic in single-threaded
    // JS). The key point is that the two counters either both move
    // or neither does — we no longer have the split-failure window
    // that the old `await kv().incrBy(); await kv().incrBy();` path
    // left open. (M-1 in docs/CODE_REVIEW-vercel-hosting-optimization.md.)
    //
    // TTLs are safely longer than the window (65s and 3700s) so
    // expired buckets get cleaned up without needing a separate
    // reaper.
    const ops: PipelineOp[] = [];
    if (config.perMinute > 0) {
      ops.push({ op: "incrBy", key: minuteKey, by: 1, ttlSeconds: 65 });
    }
    if (config.perHour > 0) {
      ops.push({ op: "incrBy", key: hourKey, by: 1, ttlSeconds: 3700 });
    }

    const results = await kv().pipeline(ops);

    // Unpack in the same order we queued the ops. When a window is
    // disabled its count is zero — that way the unused branch of the
    // later limit check is a no-op.
    let idx = 0;
    const minuteCount = config.perMinute > 0 ? results[idx++] : 0;
    const hourCount = config.perHour > 0 ? results[idx++] : 0;

    if (config.perMinute > 0 && minuteCount > config.perMinute) {
      return {
        allowed: false,
        limitedBy: "minute",
        resetAt: (minuteBucket + 1) * 60_000,
        counts: { minute: minuteCount, hour: hourCount },
      };
    }

    if (config.perHour > 0 && hourCount > config.perHour) {
      return {
        allowed: false,
        limitedBy: "hour",
        resetAt: (hourBucket + 1) * 3_600_000,
        counts: { minute: minuteCount, hour: hourCount },
      };
    }

    return {
      allowed: true,
      counts: { minute: minuteCount, hour: hourCount },
    };
  } catch (err) {
    // Fail open. The alternative — blocking requests when Redis is
    // unreachable — is strictly worse for availability.
    log.warn({ err, namespace, clientKey }, "Rate limiter error — failing open");
    return { allowed: true, counts: { minute: 0, hour: 0 } };
  }
}

/**
 * Hash an API key (or any secret) into a stable short identifier
 * suitable for use as a rate limit dimension. We never want to use
 * the raw secret as a KV key because:
 *
 *   (a) it ends up in logs (rate-limiter KV key names appear in Redis
 *       SCAN output and error messages), and
 *   (b) a leaked rate-limit key shouldn't leak the auth secret.
 *
 * Uses a fast non-cryptographic hash (FNV-1a 32-bit) because we're
 * not protecting against length-extension attacks — just making the
 * key short and stable.
 *
 * ── Collision boundary (M-4 in the code review) ────────────────────
 *
 * FNV-1a 32-bit has a 2^32 output space, so the birthday bound
 * predicts a ~50% collision probability around 2^16 ≈ 65,536
 * distinct inputs. For the current callers — OUTBOUND_API_KEY and
 * the Idempotency-Key header — this is never the bottleneck:
 *
 *   - Rate limiter: there's typically ONE API key per deployment.
 *     Single-input, zero collisions.
 *   - Idempotency cache: the Idempotency-Key is client-chosen and
 *     high-cardinality (UUIDs), so at 65k concurrent-within-24h
 *     entries you'd see your first collision. For a 30/min +
 *     500/hr rate-limited endpoint that's ~12,000 keys/day peak,
 *     well under the threshold.
 *
 * If this ever gets extended to bucket per-IP, per-tenant, or any
 * other high-cardinality dimension, upgrade to SHA-256 (truncated
 * to 8-16 hex chars). Node's `crypto.createHash('sha256')` is
 * available in every runtime we target. Rough replacement:
 *
 *   import { createHash } from "node:crypto";
 *   export function hashClientKey(secret: string): string {
 *     return createHash("sha256").update(secret).digest("hex").slice(0, 16);
 *   }
 *
 * SHA-256 truncated to 16 hex chars (64 bits) pushes the birthday
 * bound to ~4 billion distinct inputs, which is "stop worrying"
 * territory for any realistic rate-limiter cardinality.
 */
export function hashClientKey(secret: string): string {
  // FNV-1a 32-bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < secret.length; i++) {
    hash ^= secret.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
