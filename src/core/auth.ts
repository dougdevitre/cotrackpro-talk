/**
 * core/auth.ts — Shared authentication helpers.
 *
 * Why this file exists: the previous Bearer token check in
 * src/core/outbound.ts and src/core/records.ts used plain `!==` string
 * comparison, which short-circuits on the first differing character.
 * That's vulnerable to timing attacks — a sufficiently chatty attacker
 * could leak the token one character at a time over the network. The
 * risk is low in practice (JITted string compare is fast, network
 * jitter is high) but the fix is essentially free, so we do it.
 *
 * Flagged as C-2 in docs/CODE_REVIEW-vercel-hosting-optimization.md.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time match of a Bearer token against an expected value.
 *
 * Returns true if the Authorization header is `Bearer <expected>`,
 * where the comparison of `expected` and the provided token is done
 * with `crypto.timingSafeEqual` to avoid leaking a character-by-
 * character side channel.
 *
 * Returns false for:
 *   - missing / undefined header
 *   - header that doesn't start with `Bearer `
 *   - token of the wrong length (timingSafeEqual requires equal
 *     lengths; we catch this explicitly so we return false instead
 *     of throwing)
 *   - token of the right length but wrong bytes
 *
 * @param authHeader  The raw Authorization header value.
 * @param expected    The expected token (NOT including the "Bearer "
 *                    prefix).
 */
export function bearerMatches(
  authHeader: string | undefined,
  expected: string,
): boolean {
  if (!authHeader) return false;
  if (!authHeader.startsWith("Bearer ")) return false;

  const provided = authHeader.slice("Bearer ".length);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");

  // timingSafeEqual throws if the buffers are different lengths, so
  // we have to length-check first. Doing it with a non-timing-safe
  // `===` is fine: the length of the expected token isn't secret
  // (it's a compile-time constant from env).
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
