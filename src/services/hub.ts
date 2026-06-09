/**
 * services/hub.ts — Talk → Hub client (the talk-side half of the seam).
 *
 * The CoTrackPro hub owns identity, OTP, token minting, and tier logic
 * (merged hub-side in PR #182). The talk edge only needs two calls:
 *
 *   1. resolve-phone   — map an inbound caller's E.164 number to a Clerk
 *                        subject so we can act as that signed-in user.
 *   2. send-auth-link  — when a caller isn't linked yet, ask the hub to
 *                        mint a one-time token and text the caller a
 *                        sign-in link. The hub composes the whole SMS
 *                        body and sends it back through OUR /api/sms/send;
 *                        the talk edge never sees the token.
 *
 * Trust model: a single shared bearer secret authenticates hub↔talk in
 * BOTH directions. It lives in SSM at
 * /cotrackpro/<stage>/talk/outbound_api_key and is surfaced as
 * env.outboundApiKey. We PRESENT it here on calls TO the hub. Clerk is
 * never used for these server-to-server edges.
 *
 * PII: phone numbers are never logged raw — we mask them via
 * maskPhoneNumber before they reach a log line.
 *
 * Failure posture: every method returns a discriminated result rather
 * than throwing. Network errors, timeouts, and misconfiguration all map
 * to an explicit variant so the inbound voice loop can fail OPEN (treat
 * the caller as anonymous) without a try/catch at every call site.
 */

import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { maskPhoneNumber } from "./dynamo.js";

const log = logger.child({ service: "hub" });

// ── Fetch injection seam (tests) ─────────────────────────────────────────────
//
// Production uses the global fetch (Node 20+). Tests inject a stub so we
// never hit the network. Mirrors the _setKvForTests pattern in
// services/kv.ts.
type FetchLike = typeof fetch;
let _fetchImpl: FetchLike | null = null;
function doFetch(): FetchLike {
  return _fetchImpl ?? fetch;
}
/** Test-only: inject a fetch stub. Do not call in production. */
export function _setHubFetchForTests(impl: FetchLike | null): void {
  _fetchImpl = impl;
}

// ── resolve-phone ─────────────────────────────────────────────────────────────

export type ResolvePhoneResult =
  /** 200 — caller is linked; act as this Clerk subject. */
  | { status: "linked"; subject: string }
  /** 404 — caller isn't linked yet → offer to send a sign-in link. */
  | { status: "not_linked" }
  /** 401 — our bearer was bad/missing (talk misconfig). */
  | { status: "unauthorized" }
  /** 503 — hub deployed without a key (hub misconfig). */
  | { status: "not_configured" }
  /** 400 — we sent a malformed/invalid phone. */
  | { status: "invalid" }
  /** Hub disabled locally (no HUB_BASE_URL / bearer), or network/timeout
   *  /unexpected status. Caller should fail open (anonymous). */
  | { status: "error"; reason: string };

/**
 * Resolve an inbound caller's E.164 number to a Clerk subject.
 *
 *   POST {HUB_BASE_URL}/internal/v1/resolve-phone
 *   Authorization: Bearer <shared talk key>
 *   { "phone": "+15551230123" }
 */
export async function resolvePhone(phone: string): Promise<ResolvePhoneResult> {
  const cfg = hubReady();
  if (!cfg.ok) return { status: "error", reason: cfg.reason };

  return hubPost("/internal/v1/resolve-phone", { phone }, (status, body) => {
    switch (status) {
      case 200: {
        const subject = typeof body?.subject === "string" ? body.subject : "";
        if (!subject) {
          log.warn(
            { phone: maskPhoneNumber(phone) },
            "resolve-phone 200 but no subject in body",
          );
          return { status: "error", reason: "missing_subject" };
        }
        return { status: "linked", subject };
      }
      case 404:
        return { status: "not_linked" };
      case 401:
        log.error("resolve-phone 401 — talk bearer rejected by hub");
        return { status: "unauthorized" };
      case 503:
        log.error("resolve-phone 503 — hub reports resolve_not_configured");
        return { status: "not_configured" };
      case 400:
        return { status: "invalid" };
      default:
        return { status: "error", reason: `unexpected_status_${status}` };
    }
  });
}

// ── send-auth-link ────────────────────────────────────────────────────────────

export type SendAuthLinkResult =
  /** 200 — hub minted a token + sent the SMS through our /api/sms/send. */
  | { status: "sent" }
  /** 429 — too many sends to this number; back off. */
  | { status: "rate_limited" }
  /** 503 sms_delivery_unavailable — OUR /api/sms/send was unreachable. */
  | { status: "sms_unavailable" }
  /** 503 auth_link_not_configured — hub misconfig. */
  | { status: "not_configured" }
  /** 400 — invalid/missing phone. */
  | { status: "invalid" }
  /** 401 — our bearer was bad/missing. */
  | { status: "unauthorized" }
  /** Hub disabled locally, network/timeout, or unexpected status. */
  | { status: "error"; reason: string };

/**
 * Ask the hub to text an unlinked caller a one-time sign-in link.
 *
 *   POST {HUB_BASE_URL}/internal/v1/send-auth-link
 *   Authorization: Bearer <shared talk key>
 *   { "phone": "+15551230123" }
 *
 * The talk edge never sees or handles the token — the hub composes the
 * whole SMS body and sends it through OUR /api/sms/send.
 */
export async function sendAuthLink(phone: string): Promise<SendAuthLinkResult> {
  const cfg = hubReady();
  if (!cfg.ok) return { status: "error", reason: cfg.reason };

  return hubPost("/internal/v1/send-auth-link", { phone }, (status, body) => {
    switch (status) {
      case 200:
        return { status: "sent" };
      case 429:
        log.warn(
          { phone: maskPhoneNumber(phone) },
          "send-auth-link 429 — hub rate-limited this number",
        );
        return { status: "rate_limited" };
      case 503:
        // Two distinct 503 reasons share the status code; the hub names
        // which in the body. auth_link_not_configured = hub misdeploy;
        // sms_delivery_unavailable = our /api/sms/send was unreachable.
        if (body?.error === "auth_link_not_configured") {
          log.error("send-auth-link 503 — hub reports auth_link_not_configured");
          return { status: "not_configured" };
        }
        log.error("send-auth-link 503 — hub reports sms_delivery_unavailable");
        return { status: "sms_unavailable" };
      case 400:
        return { status: "invalid" };
      case 401:
        log.error("send-auth-link 401 — talk bearer rejected by hub");
        return { status: "unauthorized" };
      default:
        return { status: "error", reason: `unexpected_status_${status}` };
    }
  });
}

// ── record-consent ────────────────────────────────────────────────────────────

export type ConsentState = "opted_in" | "opted_out";

export type RecordConsentResult =
  /** 200 — hub recorded the consent change. */
  | { status: "ok" }
  /** 401 — our bearer was bad/missing. */
  | { status: "unauthorized" }
  /** 503 — hub deployed without a key (hub misconfig). */
  | { status: "not_configured" }
  /** 400 — we sent a malformed/invalid phone or state. */
  | { status: "invalid" }
  /** Hub disabled locally, network/timeout, or unexpected status. */
  | { status: "error"; reason: string };

/**
 * Tell the hub a caller opted in/out via an SMS keyword (STOP/START).
 *
 *   POST {HUB_BASE_URL}/internal/v1/record-consent
 *   Authorization: Bearer <shared talk key>
 *   { "phone": "+1...", "state": "opted_out", "channel": "sms", "keyword": "STOP" }
 *
 * The talk edge is the source of truth for the suppression LIST (it owns
 * the number); the hub records consent for its own audit/compliance. We
 * call this best-effort AFTER updating our own suppression list, so a
 * hub hiccup never leaves a user still receiving messages they stopped.
 */
export async function recordConsent(
  phone: string,
  state: ConsentState,
  keyword?: string,
): Promise<RecordConsentResult> {
  const cfg = hubReady();
  if (!cfg.ok) return { status: "error", reason: cfg.reason };

  return hubPost(
    "/internal/v1/record-consent",
    { phone, state, channel: "sms", keyword },
    (status) => {
      switch (status) {
        case 200:
        case 204:
          return { status: "ok" };
        case 401:
          log.error("record-consent 401 — talk bearer rejected by hub");
          return { status: "unauthorized" };
        case 503:
          return { status: "not_configured" };
        case 400:
          return { status: "invalid" };
        default:
          return { status: "error", reason: `unexpected_status_${status}` };
      }
    },
  );
}

// ── inbound-sms ───────────────────────────────────────────────────────────────

export type InboundSmsResult =
  /** 200 — hub handled it; `reply` (if present) should be sent as TwiML. */
  | { status: "ok"; reply?: string }
  /** 401 — our bearer was bad/missing. */
  | { status: "unauthorized" }
  /** 503 — hub misconfig. */
  | { status: "not_configured" }
  /** 400 — malformed payload. */
  | { status: "invalid" }
  /** Hub disabled locally, network/timeout, or unexpected status. */
  | { status: "error"; reason: string };

/**
 * Forward a non-keyword inbound SMS to the hub and return any reply it
 * wants delivered. The hub composes the reply text; the talk edge wraps
 * it in TwiML (appending the canonical opt-out footer).
 *
 *   POST {HUB_BASE_URL}/internal/v1/inbound-sms
 *   Authorization: Bearer <shared talk key>
 *   { "from": "+1...", "to": "+1...", "body": "...", "messageSid": "SM..." }
 */
export async function forwardInboundSms(args: {
  from: string;
  to: string;
  body: string;
  messageSid?: string;
}): Promise<InboundSmsResult> {
  const cfg = hubReady();
  if (!cfg.ok) return { status: "error", reason: cfg.reason };

  return hubPost("/internal/v1/inbound-sms", { ...args }, (status, body) => {
    switch (status) {
      case 200: {
        const reply =
          typeof body?.reply === "string" && body.reply.length > 0
            ? body.reply
            : undefined;
        return { status: "ok", reply };
      }
      case 401:
        log.error("inbound-sms 401 — talk bearer rejected by hub");
        return { status: "unauthorized" };
      case 503:
        return { status: "not_configured" };
      case 400:
        return { status: "invalid" };
      default:
        return { status: "error", reason: `unexpected_status_${status}` };
    }
  });
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Whether the hub integration is configured enough to attempt a call. */
function hubReady():
  | { ok: true }
  | { ok: false; reason: string } {
  if (!env.hubBaseUrl) return { ok: false, reason: "hub_disabled" };
  if (!env.outboundApiKey) return { ok: false, reason: "bearer_unset" };
  return { ok: true };
}

/**
 * Shared POST machinery: bearer auth, JSON body, AbortController timeout,
 * and a per-endpoint status mapper. Network/timeout/parse failures are
 * folded into an `{ status: "error" }`-shaped result by the mapper's
 * fallback — they never throw.
 */
async function hubPost<T extends { status: string }>(
  path: string,
  payload: Record<string, unknown>,
  map: (status: number, body: Record<string, unknown> | undefined) => T,
): Promise<T> {
  const url = `${env.hubBaseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.hubTimeoutMs);

  try {
    const res = await doFetch()(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.outboundApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    let body: Record<string, unknown> | undefined;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = undefined; // some statuses may have empty bodies
    }

    return map(res.status, body);
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError" ? "timeout" : "network";
    log.warn({ err, path }, `Hub call failed (${reason}) — failing open`);
    // The mapper's fallback shape — every result union has an "error"
    // variant with a `reason`, so this is safe to construct directly.
    return { status: "error", reason } as unknown as T;
  } finally {
    clearTimeout(timer);
  }
}
