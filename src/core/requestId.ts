/**
 * core/requestId.ts — HTTP request correlation.
 *
 * Stamps a short random request ID on every HTTP request so log
 * lines emitted during a single request can be grep'd together.
 * Previously the only correlation key on HTTP handlers was
 * `{ callSid }` on Twilio-initiated flows; general HTTP traffic
 * (outbound API, records, dashboard, cron) had nothing.
 *
 * Audit P-5 in docs/CODE_REVIEW-vercel-hosting-optimization.md.
 *
 * Two behaviors:
 *
 *   1. If the incoming request has an `x-request-id` header (set by
 *      an upstream proxy, Vercel edge, or a caller that wants
 *      end-to-end tracing), we honor it — length-capped to 128 chars
 *      and filtered to printable ASCII to prevent log injection.
 *
 *   2. Otherwise we generate a new 16-hex-char random ID. Cheap,
 *      non-cryptographic, collision-free for realistic traffic
 *      volumes (~18 quadrillion distinct IDs before a birthday
 *      collision at 50% probability).
 *
 * The ID is:
 *   - echoed back to the caller via the `x-request-id` response
 *     header (so an HTTP client with no prior ID can correlate
 *     against server logs)
 *   - attached to a child logger via `logger.child({ requestId })`
 */

import { randomBytes } from "node:crypto";
import { logger } from "../utils/logger.js";
import type { Logger } from "pino";

/** Max accepted length for an inbound x-request-id header. */
const MAX_INBOUND_ID_LENGTH = 128;

/** Printable-ASCII filter for inbound IDs. */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

/**
 * Generate a 16-hex-char random ID. Non-crypto because this isn't a
 * security boundary — it's a correlation key. 8 bytes of randomness
 * gives 2^64 distinct values which is far beyond any realistic
 * collision concern.
 */
export function generateRequestId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Resolve the request ID for an incoming HTTP request.
 *
 * @param header  Raw `x-request-id` header value (may be absent,
 *                string, or string[] for repeated headers).
 */
export function resolveRequestId(
  header: string | string[] | undefined,
): string {
  if (!header) return generateRequestId();
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return generateRequestId();
  if (raw.length > MAX_INBOUND_ID_LENGTH) return generateRequestId();
  if (!PRINTABLE_ASCII.test(raw)) return generateRequestId();
  return raw;
}

/**
 * Returns a pino child logger bound to `{ requestId }`. All log
 * lines emitted through it will carry the key for grep/filter.
 */
export function requestLogger(requestId: string): Logger {
  return logger.child({ requestId });
}
