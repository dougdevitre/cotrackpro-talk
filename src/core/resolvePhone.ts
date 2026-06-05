/**
 * core/resolvePhone.ts — Trusted resolve edge client (talk → hub).
 *
 * On an inbound call, the voice surface asks the CoTrackPro hub to map
 * the caller's phone number to a Clerk subject, so any artifacts the
 * call produces get attributed to the right account. This is the
 * talk-side half of the phone↔account-linking (F7) seam; the hub half
 * is `POST /internal/v1/resolve-phone` in the connector router,
 * authenticated by the shared talk bearer (never Clerk, never exposed
 * to MCP/REST callers).
 *
 * Contract (hub side):
 *   POST {HUB_BASE_URL}/internal/v1/resolve-phone
 *   Authorization: Bearer <OUTBOUND_API_KEY>
 *   { "phone": "+1..." }
 *     → 200 { "subject": "<clerk subject>" }
 *     → 404 { "error": "not_linked" }   (caller unlinked → anonymous)
 *     → 400 { "error": "missing_phone" }
 *
 * This call sits inline in the Twilio webhook path, so it is strictly
 * fail-open: any non-200 (including 404 "not linked"), a timeout, or a
 * network error resolves to `null` and the call proceeds anonymously.
 * It NEVER throws into the webhook handler — a hub outage must not stop
 * calls from connecting.
 */

import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ core: "resolvePhone" });

const RESOLVE_PATH = "/internal/v1/resolve-phone";
// Short timeout — this is on the call-setup hot path. A linked-account
// lookup that takes longer than this isn't worth delaying the greeting
// for; we fall back to anonymous.
const RESOLVE_TIMEOUT_MS = 1500;

/**
 * Resolve an inbound caller's E.164 number to its Clerk subject, or
 * `null` when the number isn't linked / the hub is unreachable /
 * resolution isn't configured.
 *
 * No-op (returns null) when HUB_BASE_URL is unset — mirrors the
 * hub-side talk-client's "no-op until base URL set" pattern, so local
 * dev and single-host deployments without the connector run fine.
 */
export async function resolvePhoneToSubject(
  phoneE164: string,
): Promise<string | null> {
  if (!env.hubBaseUrl) return null;
  if (!phoneE164 || phoneE164 === "unknown") return null;

  try {
    const res = await fetch(`${env.hubBaseUrl}${RESOLVE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.outboundApiKey}`,
      },
      body: JSON.stringify({ phone: phoneE164 }),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });

    if (res.status === 404) {
      // Expected for any caller who hasn't linked their number.
      return null;
    }
    if (!res.ok) {
      log.warn({ status: res.status }, "Resolve edge returned non-OK — anonymous");
      return null;
    }

    const data = (await res.json()) as { subject?: unknown };
    const subject = typeof data.subject === "string" ? data.subject : null;
    if (!subject) {
      log.warn("Resolve edge 200 without a subject — anonymous");
      return null;
    }
    return subject;
  } catch (err) {
    // Timeout / network / parse error → fail open to anonymous.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Resolve edge call failed — anonymous",
    );
    return null;
  }
}
