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

import { kv } from "../services/kv.js";
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
    // Increment both counters. We set a TTL that's safely longer than
    // the window (65s and 3700s) so expired buckets get cleaned up
    // without needing a separate reaper. incrBy(key, 1, ttl) only sets
    // the TTL on creation, matching Redis INCR + EXPIRE NX.
    const minuteCount =
      config.perMinute > 0 ? await kv().incrBy(minuteKey, 1, 65) : 0;
    const hourCount =
      config.perHour > 0 ? await kv().incrBy(hourKey, 1, 3700) : 0;

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
 * Uses a fast non-cryptographic hash (FNV-1a) — we're not protecting
 * against length-extension attacks, just making the key short and
 * stable.
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
