/**
 * core/sms.ts — Framework-agnostic SMS send (hub → talk seam).
 *
 *   POST /api/sms/send
 *   Authorization: Bearer <shared talk key>
 *   { to, body, dedupeKey }
 *
 * The hub composes the entire SMS `body` (including any OTP / sign-in
 * link) and calls this endpoint to deliver it through OUR Twilio number.
 * The talk edge ONLY transmits the body — it never generates or inspects
 * tokens. Idempotent on `dedupeKey` so a hub retry can't double-send.
 *
 * This mirrors src/core/outbound.ts: same shared-bearer auth
 * (constant-time via bearerMatches), same E.164 + country allow-list
 * (validateDialable), same KV-backed rate limiting and idempotency. The
 * discriminated-union result the caller (Fastify or Vercel) maps to an
 * HTTP response is the same shape language too.
 *
 * PII: phone numbers are masked in every log line; the message body is
 * never logged (it can contain a one-time sign-in link).
 */

import twilio from "twilio";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { authorizeHubBearer } from "./auth.js";
import { validateDialable } from "./phoneValidation.js";
import { checkRateLimit, hashClientKey } from "./rateLimit.js";
import {
  lookupIdempotent,
  parseIdempotencyKey,
  storeIdempotent,
} from "./idempotency.js";
import { isSuppressed } from "./consent.js";
import { maskPhoneNumber } from "../services/dynamo.js";

const log = logger.child({ core: "sms" });

/**
 * Idempotency TTL for sends. The dedupeKey must dedupe a hub retry for
 * far longer than the 24h HTTP default — reminder sends can be retried
 * days later — so we hold the sent-record for 30 days.
 */
const SEND_IDEMPOTENCY_TTL_SECONDS = 30 * 24 * 60 * 60;

// ── Twilio sender (injectable for tests) ──────────────────────────────────────
//
// Production lazily constructs one Twilio client per process and sends
// via messages.create. Tests inject a stub so they never touch the
// network — mirrors the DI seams elsewhere in the codebase.

export type SmsSender = (args: {
  to: string;
  body: string;
}) => Promise<{ sid: string }>;

let _client: ReturnType<typeof twilio> | null = null;
function twilioClient(): ReturnType<typeof twilio> {
  if (!_client) _client = twilio(env.twilioAccountSid, env.twilioAuthToken);
  return _client;
}

/**
 * Build the `messages.create` params. Outbound SMS is attributed to the
 * approved A2P 10DLC brand/campaign by sending through the Messaging
 * Service SID — NOT a bare from-number — whenever one is configured.
 * The from-number is only used as a local/test fallback; production
 * enforces the Messaging Service via `smsRoutingConfigError` below.
 *
 * Exported for unit testing the routing decision without hitting Twilio.
 */
export function buildSmsCreateParams(
  to: string,
  body: string,
): { to: string; body: string; messagingServiceSid?: string; from?: string } {
  if (env.twilioMessagingServiceSid) {
    return { to, body, messagingServiceSid: env.twilioMessagingServiceSid };
  }
  return { to, body, from: env.twilioPhoneNumber };
}

let _senderImpl: SmsSender | null = null;
function sender(): SmsSender {
  return (
    _senderImpl ??
    (async ({ to, body }) => {
      const msg = await twilioClient().messages.create(
        buildSmsCreateParams(to, body),
      );
      return { sid: msg.sid };
    })
  );
}
/** Test-only: inject an SMS sender stub. Do not call in production. */
export function _setSmsSenderForTests(impl: SmsSender | null): void {
  _senderImpl = impl;
}

// ── Result types ──────────────────────────────────────────────────────────────

export type SmsRequest = {
  to?: string;
  body?: string;
  dedupeKey?: string;
};

export type SmsResult =
  | {
      ok: true;
      status: 200;
      body: { sid: string };
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      status: 400;
      body: { error: string; details?: string };
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      status: 401;
      body: { error: string };
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      status: 503;
      body: { error: string };
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      status: 429;
      body: { error: string; details?: string; retryAfterSeconds: number };
      headers: Record<string, string>;
    }
  | {
      ok: false;
      status: 500;
      body: { error: string; details?: string };
      headers?: Record<string, string>;
    };

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Verify the shared hub↔talk bearer (constant-time) via the shared
 * authorizeHubBearer helper. Returns null on success, or a 401 (bearer
 * absent/wrong) / 503 (key unconfigured in prod) SmsResult to return
 * verbatim. Outside production an unset key is the local-dev escape
 * hatch (returns null).
 */
export function authorizeInboundSms(authHeader: string | undefined): SmsResult | null {
  const err = authorizeHubBearer(authHeader, "/api/sms/send");
  if (!err) return null;
  return { ok: false, status: err.status, body: { error: err.error } };
}

/** Rate-limit keyed on the presented bearer (hashed). Mirrors outbound. */
export async function checkSmsRateLimit(
  authHeader: string | undefined,
): Promise<SmsResult | null> {
  const rawKey = env.outboundApiKey
    ? (authHeader?.replace(/^Bearer\s+/i, "") ?? "anonymous")
    : "anonymous";
  const clientKey = hashClientKey(rawKey);

  const result = await checkRateLimit(clientKey, "sms", {
    perMinute: env.smsRateLimitPerMin,
    perHour: env.smsRateLimitPerHour,
  });
  if (result.allowed) return null;

  const retryAfterSeconds = result.resetAt
    ? Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
    : 60;

  log.warn(
    { clientKey, limitedBy: result.limitedBy, retryAfterSeconds },
    "SMS send rate-limited",
  );

  return {
    ok: false,
    status: 429,
    body: {
      error: "rate_limited",
      details: `Rate limit exceeded (${result.limitedBy} window)`,
      retryAfterSeconds,
    },
    headers: { "Retry-After": String(retryAfterSeconds) },
  };
}

// ── Send ──────────────────────────────────────────────────────────────────────

/**
 * Send `body` to `to` via the Twilio number. Idempotent on `dedupeKey`:
 * the first send with a given key is cached for 24h, and any later send
 * with the same key replays the cached result (X-Idempotent-Replay:true)
 * without re-sending. Validates the destination is a dialable/textable
 * E.164 number in the allow-list before touching Twilio.
 */
export async function sendSms(body: SmsRequest | undefined): Promise<SmsResult> {
  // dedupeKey is REQUIRED: it's the idempotency key, and the endpoint's
  // retry-safety guarantee (a hub retry never double-sends) only holds
  // when it's present. A missing key is a contract violation, not an
  // opt-out of idempotency — fail closed with 400.
  if (!body?.dedupeKey) {
    return { ok: false, status: 400, body: { error: "missing 'dedupeKey'" } };
  }
  // dedupeKey runs through the same validation as the Idempotency-Key
  // header (length + printable-ASCII) so the hub can't smuggle a giant
  // or control-char-laden key into Redis key names.
  const keyParse = parseIdempotencyKey(body.dedupeKey);
  if (!keyParse.ok) return keyParse;
  const dedupeHash = keyParse.key;

  // Idempotency replay BEFORE validation/work so a retry returns the
  // exact prior result.
  const lookup = await lookupIdempotent<SmsResult>("sms", dedupeHash);
  if (lookup.hit) {
    log.info({ dedupeHash }, "SMS send idempotent replay");
    const cached = lookup.cachedValue;
    return {
      ...cached,
      headers: { ...(cached.headers ?? {}), "X-Idempotent-Replay": "true" },
    } as SmsResult;
  }

  if (!body?.to) {
    return { ok: false, status: 400, body: { error: "missing 'to'" } };
  }
  if (typeof body.body !== "string" || body.body.length === 0) {
    return { ok: false, status: 400, body: { error: "missing 'body'" } };
  }

  const phoneCheck = validateDialable(body.to);
  if (!phoneCheck.ok) {
    log.warn(
      { to: maskPhoneNumber(body.to), reason: phoneCheck.reason },
      "SMS send rejected — phone failed validation",
    );
    const result: SmsResult = {
      ok: false,
      status: 400,
      body: { error: "invalid 'to'", details: phoneCheck.detail },
    };
    // Cache the deterministic 400 — same bad input always fails the same
    // way; don't let retries burn rate-limit budget re-validating.
    await storeIdempotent("sms", dedupeHash, result, SEND_IDEMPOTENCY_TTL_SECONDS);
    return result;
  }

  // Suppression: if the destination has opted out (replied STOP), do NOT
  // send. Return a non-error sentinel so the hub treats the send as
  // HANDLED (not a failure to retry) — the message is simply suppressed.
  // Cached under the dedupeKey so replays stay consistent.
  if (await isSuppressed(body.to)) {
    log.info({ to: maskPhoneNumber(body.to) }, "SMS send suppressed (opted out)");
    // Deliberately NOT cached: suppression is mutable. If the number later
    // replies START (opts back in) and the hub retries the SAME dedupeKey,
    // we must re-check isSuppressed and actually send — a cached
    // "suppressed" would silently swallow that message for up to 30 days.
    return { ok: true, status: 200, body: { sid: "suppressed" } };
  }

  // A2P enforcement: in production we refuse to send without a Messaging
  // Service SID, so a misconfigured deploy can't silently fall back to a
  // bare from-number and send unattributed (campaign-violating) traffic.
  // Not cached — this is an operational misconfig, not a property of the
  // request, and should clear the moment the SID is set.
  if (!env.twilioMessagingServiceSid && env.nodeEnv === "production") {
    log.error(
      "TWILIO_MESSAGING_SERVICE_SID is unset in production — refusing to send unattributed SMS.",
    );
    return {
      ok: false,
      status: 500,
      body: {
        error: "sms_misconfigured",
        details: "TWILIO_MESSAGING_SERVICE_SID is required in production",
      },
    };
  }

  const to = body.to;
  try {
    const { sid } = await sender()({ to, body: body.body });
    log.info({ sid, to: maskPhoneNumber(to) }, "SMS sent");

    const result: SmsResult = {
      ok: true,
      status: 200,
      body: { sid },
      headers: dedupeHash ? { "X-Idempotent-Replay": "false" } : undefined,
    };
    await storeIdempotent("sms", dedupeHash, result, SEND_IDEMPOTENCY_TTL_SECONDS);
    return result;
  } catch (err) {
    log.error({ err, to: maskPhoneNumber(to) }, "Failed to send SMS");
    // Deliberately NOT cached — transient Twilio failures should be
    // retryable on the same dedupeKey.
    return {
      ok: false,
      status: 500,
      body: {
        error: "send_failed",
        details: err instanceof Error ? err.message : "unknown",
      },
    };
  }
}
