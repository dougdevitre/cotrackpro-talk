/**
 * core/idempotency.ts — HTTP idempotency key handling.
 *
 * Implements the standard "Idempotency-Key" pattern (Stripe, Twilio
 * Messaging, PayPal, and most modern payment APIs):
 *
 *   1. Client sends `Idempotency-Key: <unique string>` on a mutating
 *      request (e.g. POST /call/outbound).
 *   2. The first time we see that key, we compute the result, cache
 *      it under the key for a TTL, and return it with a
 *      `X-Idempotent-Replay: false` header so the client knows the
 *      work ran.
 *   3. Any subsequent request with the same key within the TTL gets
 *      the exact cached response back with `X-Idempotent-Replay: true`.
 *
 * The primary failure mode this closes: a client retries a POST
 * /call/outbound because the first response was lost to a network
 * blip. Without idempotency, that dials two calls and charges twice.
 * Flagged as M-3 in docs/CODE_REVIEW-vercel-hosting-optimization.md.
 *
 * Storage: uses the KV abstraction (src/services/kv.ts). With the
 * default in-memory backend, idempotency is per-process (good enough
 * for single-host). With Upstash Redis / Vercel KV configured, it's
 * shared across all Vercel functions and WS instances.
 *
 * Race caveat: this uses a naive check-then-set flow. Two concurrent
 * requests with the same key CAN both miss the cache and both proceed
 * to do work. We accept this because:
 *   (a) clients don't normally send concurrent requests with the same
 *       key — the whole point of idempotency is to retry AFTER the
 *       first response failed,
 *   (b) /call/outbound is rate-limited to 30/min per API key, so
 *       the blast radius is tiny,
 *   (c) fixing it properly requires atomic SETNX + polling on replay,
 *       which adds complexity for a hypothetical edge case. The
 *       cheaper atomic fix is documented in the file but not
 *       implemented until needed.
 *
 * Key format: clients can pass any string. We length-check it (1-256
 * chars) and hash it with FNV-1a for a stable short KV key. Hashing
 * avoids storing user-chosen data verbatim in Redis key names and
 * gives us bounded key size.
 */

import { kv } from "../services/kv.js";
import { logger } from "../utils/logger.js";
import { hashClientKey } from "./rateLimit.js";

const log = logger.child({ core: "idempotency" });

/** Max accepted length for an `Idempotency-Key` header value. */
const MAX_KEY_LENGTH = 256;

/** Default TTL for cached idempotent responses. 24 hours is the
 *  Stripe / Twilio industry default and matches common retry windows. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export type IdempotencyLookupResult<T> =
  | { hit: false; key: string | null }
  | { hit: true; key: string; cachedValue: T };

export type IdempotencyKeyError =
  | { ok: false; status: 400; body: { error: string; details: string } };

/**
 * Parse and validate an `Idempotency-Key` header. Returns:
 *   - { ok: true, key: null }     → header absent, caller should proceed
 *                                    without caching
 *   - { ok: true, key: "<hash>" } → header present and valid
 *   - { ok: false, status: 400 }  → header present but malformed
 *
 * We reject malformed headers with 400 rather than silently ignoring
 * them because a client that intended idempotency and got it dropped
 * silently would be a bug waiting to happen.
 */
export function parseIdempotencyKey(
  header: string | string[] | undefined,
):
  | { ok: true; key: string | null }
  | IdempotencyKeyError {
  // Header absent — caller proceeds without idempotency.
  if (header === undefined) return { ok: true, key: null };

  // If the header array-form arrives (shouldn't normally happen for
  // this header, but be safe), take the first entry.
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || raw.length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Invalid Idempotency-Key",
        details: "Idempotency-Key header is present but empty",
      },
    };
  }

  if (raw.length > MAX_KEY_LENGTH) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Invalid Idempotency-Key",
        details: `Idempotency-Key must be <= ${MAX_KEY_LENGTH} characters`,
      },
    };
  }

  // Printable ASCII only. Rejects control chars, whitespace-only
  // keys, and non-ASCII encodings that might cause Redis grief.
  if (!/^[\x20-\x7E]+$/.test(raw)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Invalid Idempotency-Key",
        details: "Idempotency-Key must contain only printable ASCII",
      },
    };
  }

  // Hash for a bounded, stable KV key name. The raw key never lands
  // in Redis.
  return { ok: true, key: hashClientKey(raw) };
}

/**
 * Look up an idempotency cache entry. Returns { hit: false } on cache
 * miss, cache disabled (key is null), or any KV error. We fail open
 * on KV errors — a degraded cache shouldn't block legitimate work.
 */
export async function lookupIdempotent<T>(
  namespace: string,
  hashedKey: string | null,
): Promise<IdempotencyLookupResult<T>> {
  if (!hashedKey) return { hit: false, key: null };

  const kvKey = `idem:${namespace}:${hashedKey}`;
  try {
    const raw = await kv().get(kvKey);
    if (!raw) return { hit: false, key: hashedKey };
    const cachedValue = JSON.parse(raw) as T;
    return { hit: true, key: hashedKey, cachedValue };
  } catch (err) {
    log.warn(
      { err, namespace, hashedKey },
      "Idempotency lookup failed — failing open",
    );
    return { hit: false, key: hashedKey };
  }
}

/**
 * Store an idempotency cache entry. No-op when the key is null
 * (client didn't send Idempotency-Key) or on KV error. We fail open
 * on KV errors: the actual work already succeeded, and failing the
 * response because we couldn't cache it would be strictly worse.
 */
export async function storeIdempotent<T>(
  namespace: string,
  hashedKey: string | null,
  value: T,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  if (!hashedKey) return;

  const kvKey = `idem:${namespace}:${hashedKey}`;
  try {
    await kv().set(kvKey, JSON.stringify(value), ttlSeconds);
  } catch (err) {
    log.warn(
      { err, namespace, hashedKey },
      "Idempotency store failed — cached replay will be unavailable",
    );
  }
}
