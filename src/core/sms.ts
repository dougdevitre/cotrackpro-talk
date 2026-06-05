/**
 * core/sms.ts — Framework-agnostic SMS (OTP) delivery.
 *
 * Sends an SMS through the voice surface's Twilio number. The primary
 * caller is the CoTrackPro hub's phone↔account-linking flow: the hub
 * composes a one-time-passcode message and POSTs it to /api/sms/send so
 * the code reaches the user from the same number they call. The hub
 * authenticates with the shared talk bearer (OUTBOUND_API_KEY) — the
 * same token /call/outbound already requires — and supplies a
 * `dedupeKey` we treat as an idempotency key so a hub retry never sends
 * the same code twice.
 *
 * Structure mirrors core/outbound.ts: a discriminated result union the
 * Fastify and Vercel adapters map to an HTTP response, auth + rate-limit
 * helpers shared in shape with their outbound counterparts, and the
 * Twilio REST call behind a small DI seam so tests can exercise the
 * happy path and the replay path without touching the network.
 */

import twilio from "twilio";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { checkRateLimit, hashClientKey } from "./rateLimit.js";
import { validateDialable } from "./phoneValidation.js";
import {
  lookupIdempotent,
  parseIdempotencyKey,
  storeIdempotent,
} from "./idempotency.js";

const log = logger.child({ core: "sms" });

// Singleton Twilio client — created once per serverless instance and
// reused across warm invocations, same as core/outbound.ts.
const twilioClient = twilio(env.twilioAccountSid, env.twilioAuthToken);

/**
 * DI seam for the actual Twilio send. Defaults to the real REST call;
 * tests inject a fake via `_setSmsSenderForTests` so they can assert the
 * happy path and confirm idempotent replays don't re-send. Mirrors the
 * `makeSttStream` / KV seams used elsewhere in the codebase.
 */
export type SmsSender = (args: {
  to: string;
  from: string;
  body: string;
}) => Promise<{ sid: string }>;

let smsSender: SmsSender | null = null;

function getSender(): SmsSender {
  if (smsSender) return smsSender;
  return async ({ to, from, body }) => {
    const msg = await twilioClient.messages.create({ to, from, body });
    return { sid: msg.sid };
  };
}

/** Test-only: inject a fake sender (or null to restore the real one). */
export function _setSmsSenderForTests(sender: SmsSender | null): void {
  smsSender = sender;
}

export type SmsRequest = {
  to?: string;
  body?: string;
  /** Hub-supplied de-duplication key; used as the idempotency key. */
  dedupeKey?: string;
};

// Discriminated union — same shape contract as OutboundResult so the
// adapters can stay near-identical. See core/outbound.ts for the
// rationale behind narrowing each status to exactly its fields.

export type SmsSuccess = {
  ok: true;
  status: 200;
  body: { success: true; sid: string; to: string };
  headers?: Record<string, string>;
};

export type SmsBadRequest = {
  ok: false;
  status: 400;
  body: { error: string; details?: string };
  headers?: Record<string, string>;
};

export type SmsUnauthorized = {
  ok: false;
  status: 401;
  body: { error: string };
  headers?: Record<string, string>;
};

export type SmsRateLimited = {
  ok: false;
  status: 429;
  body: { error: string; details?: string; retryAfterSeconds: number };
  headers: Record<string, string>;
};

export type SmsServerError = {
  ok: false;
  status: 500;
  body: { error: string; details?: string };
  headers?: Record<string, string>;
};

export type SmsResult =
  | SmsSuccess
  | SmsBadRequest
  | SmsUnauthorized
  | SmsRateLimited
  | SmsServerError;

/**
 * Rate-limit check keyed on the caller's bearer (hashed), in its own
 * "sms" namespace so it doesn't share a budget with /call/outbound.
 * Identical structure to checkOutboundRateLimit.
 */
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
    {
      clientKey,
      limitedBy: result.limitedBy,
      counts: result.counts,
      retryAfterSeconds,
    },
    "SMS send rate-limited",
  );

  return {
    ok: false,
    status: 429,
    body: {
      error: "Too many requests",
      details: `Rate limit exceeded (${result.limitedBy} window)`,
      retryAfterSeconds,
    },
    headers: { "Retry-After": String(retryAfterSeconds) },
  };
}

/**
 * Send an SMS. Validates input, then calls Twilio. The hub's
 * `dedupeKey` is used as the idempotency key: the result of the first
 * successful-or-deterministically-failed send with that key is cached
 * for 24h, and a retry returns the cached response with
 * `X-Idempotent-Replay: true` without sending again. Transient 500s are
 * never cached — retries must be able to get past a transient Twilio
 * failure. Same idempotency contract as initiateOutboundCall.
 */
export async function sendSms(
  body: SmsRequest | undefined,
): Promise<SmsResult> {
  // The hub passes the de-dupe token in the JSON body (not as an
  // Idempotency-Key header), so we feed it through the same validator.
  const keyParse = parseIdempotencyKey(body?.dedupeKey);
  if (!keyParse.ok) return keyParse;
  const idempotencyHash = keyParse.key;

  const lookup = await lookupIdempotent<SmsResult>("sms", idempotencyHash);
  if (lookup.hit) {
    log.info({ idempotencyHash }, "SMS send idempotent replay");
    const cached = lookup.cachedValue;
    return {
      ...cached,
      headers: {
        ...(cached.headers ?? {}),
        "X-Idempotent-Replay": "true",
      },
    } as SmsResult;
  }

  if (!body?.to) {
    return { ok: false, status: 400, body: { error: "Missing 'to' phone number" } };
  }

  // Reuse the outbound phone guard: E.164 + country allow-list. A
  // leaked talk bearer shouldn't be able to text premium international
  // destinations any more than it could dial them.
  const phoneCheck = validateDialable(body.to);
  if (!phoneCheck.ok) {
    log.warn(
      { to: body.to, reason: phoneCheck.reason },
      "SMS send rejected — phone number failed validation",
    );
    const result: SmsResult = {
      ok: false,
      status: 400,
      body: { error: "Invalid destination phone number", details: phoneCheck.detail },
    };
    await storeIdempotent("sms", idempotencyHash, result);
    return result;
  }

  if (typeof body.body !== "string" || body.body.trim().length === 0) {
    const result: SmsResult = {
      ok: false,
      status: 400,
      body: { error: "Missing message body" },
    };
    await storeIdempotent("sms", idempotencyHash, result);
    return result;
  }

  const to = body.to;
  try {
    const { sid } = await getSender()({
      to,
      from: env.twilioPhoneNumber,
      body: body.body,
    });

    log.info({ sid, to }, "SMS sent");

    const result: SmsResult = {
      ok: true,
      status: 200,
      body: { success: true, sid, to },
      headers: idempotencyHash ? { "X-Idempotent-Replay": "false" } : undefined,
    };
    await storeIdempotent("sms", idempotencyHash, result);
    return result;
  } catch (err) {
    log.error({ err, to }, "Failed to send SMS");
    // Deliberately NOT cached — transient Twilio errors must stay
    // retryable.
    return {
      ok: false,
      status: 500,
      body: {
        error: "Failed to send SMS",
        details: err instanceof Error ? err.message : "unknown",
      },
    };
  }
}
