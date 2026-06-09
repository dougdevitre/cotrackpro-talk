/**
 * core/voiceOutbound.ts — One-shot outbound voice (hub → talk seam).
 *
 *   POST /api/call/outbound
 *   Authorization: Bearer <shared talk key>
 *   { to, voiceId, line, dedupeKey }
 *   → 200 { callSid }
 *
 * The hub asks the talk edge to PLACE A CALL that plays a single `line`
 * in a named voice (e.g. "doug-voice" — Doug's cloned ElevenLabs voice)
 * and hangs up. This is the higher-cost, more-intrusive sibling of
 * /api/sms/send (a Doug's-voice reminder reaching a phone), so it carries
 * the same defenses PLUS a hard per-day cap and a voice-specific render.
 *
 * Mechanics (full ElevenLabs render):
 *   1. Authorize the shared bearer, validate the destination + line,
 *      honor the suppression list, and dedupe on `dedupeKey`.
 *   2. Resolve the voiceId ("doug-voice" → SSM voice_id), stash
 *      { voiceId, line } in KV under a SIGNED token, and `calls.create`
 *      with TwiML that <Play>s our /call/voice-line?id=<token> URL.
 *   3. Twilio fetches that URL (api/call/voice-line.ts), which renders
 *      the line via ElevenLabs and streams the audio back. The render is
 *      deferred to fetch time so KV holds only a tiny pointer, and the
 *      token is HMAC-signed so a leaked URL can't enumerate or coerce
 *      arbitrary renders (bill-fraud protection).
 *
 * This mirrors src/core/sms.ts: same shared-bearer auth, same
 * E.164 + country allow-list, KV idempotency, and discriminated-union
 * result shape. The Twilio `calls.create` and the ElevenLabs render are
 * both injectable so tests never touch the network.
 *
 * PII: phone numbers are masked in every log line; the spoken `line` is
 * never logged — the dedupeKey is the only correlation id.
 */

import { createHmac, randomUUID } from "node:crypto";
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
import { resolveVoiceId } from "../config/voices.js";
import { kv } from "../services/kv.js";
import { escapeXmlAttr } from "./twiml.js";
import { maskPhoneNumber } from "../services/dynamo.js";

const log = logger.child({ core: "voiceOutbound" });

/** Dedupe a hub retry for 30 days, same as SMS sends. */
const CALL_IDEMPOTENCY_TTL_SECONDS = 30 * 24 * 60 * 60;

// ── Twilio call placer (injectable for tests) ─────────────────────────────────

export type VoiceCaller = (args: {
  to: string;
  /** Resolved ElevenLabs voice_id this call will play. */
  voiceId: string;
  twiml: string;
}) => Promise<{ callSid: string }>;

let _client: ReturnType<typeof twilio> | null = null;
function twilioClient(): ReturnType<typeof twilio> {
  if (!_client) _client = twilio(env.twilioAccountSid, env.twilioAuthToken);
  return _client;
}

let _callerImpl: VoiceCaller | null = null;
function caller(): VoiceCaller {
  return (
    _callerImpl ??
    (async ({ to, twiml }) => {
      const call = await twilioClient().calls.create({
        to,
        from: env.twilioPhoneNumber,
        twiml,
        statusCallback: `https://${env.apiDomain}/call/status`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });
      return { callSid: call.sid };
    })
  );
}

/** Test-only: inject a Twilio call placer. Do not call in production. */
export function _setVoiceCallerForTests(impl: VoiceCaller | null): void {
  _callerImpl = impl;
}

// ── Voice-line render token (signed pointer Twilio fetches) ───────────────────

/** HMAC-sign a render id so /call/voice-line only serves tokens WE
 *  issued. Keyed on the shared bearer (always set in prod). */
function signToken(id: string): string {
  const secret = env.outboundApiKey || "dev-unsigned";
  const mac = createHmac("sha256", secret).update(id).digest("hex").slice(0, 32);
  return `${id}.${mac}`;
}

/** Verify + parse a signed token; returns the bare id or null. */
export function verifyVoiceLineToken(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  return signToken(id) === token ? id : null;
}

function voiceLineKvKey(id: string): string {
  return `voiceline:${id}`;
}

export type PendingVoiceLine = { voiceId: string; line: string };

/** Fetch the { voiceId, line } stashed for a render token. Null if the
 *  token is unknown/expired or KV is unreachable. */
export async function loadVoiceLine(id: string): Promise<PendingVoiceLine | null> {
  try {
    const raw = await kv().get(voiceLineKvKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as PendingVoiceLine;
  } catch {
    return null;
  }
}

// ── Result types ──────────────────────────────────────────────────────────────

export type VoiceOutboundRequest = {
  to?: string;
  voiceId?: string;
  line?: string;
  dedupeKey?: string;
};

export type VoiceOutboundResult =
  | {
      ok: true;
      status: 200;
      body: { callSid: string };
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
      status: 401 | 503;
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

/** Verify the shared bearer. null on success, else 401/503 to return. */
export function authorizeVoiceOutbound(
  authHeader: string | undefined,
): VoiceOutboundResult | null {
  const err = authorizeHubBearer(authHeader, "/api/call/outbound");
  if (!err) return null;
  return { ok: false, status: err.status, body: { error: err.error } };
}

/** Per-key rate limit incl. the hard per-day cap. */
export async function checkVoiceOutboundRateLimit(
  authHeader: string | undefined,
): Promise<VoiceOutboundResult | null> {
  const rawKey = env.outboundApiKey
    ? (authHeader?.replace(/^Bearer\s+/i, "") ?? "anonymous")
    : "anonymous";
  const clientKey = hashClientKey(rawKey);

  const result = await checkRateLimit(clientKey, "voice", {
    perMinute: env.outboundRateLimitPerMin,
    perHour: env.outboundRateLimitPerHour,
    perDay: env.callDailyCap,
  });
  if (result.allowed) return null;

  const retryAfterSeconds = result.resetAt
    ? Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
    : 60;

  log.warn(
    { clientKey, limitedBy: result.limitedBy, retryAfterSeconds },
    "Outbound voice rate-limited",
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

// ── Place ───────────────────────────────────────────────────────────────────

/**
 * Place a one-shot voice call that plays `line` in the resolved voice.
 * Idempotent on `dedupeKey`: a repeat returns the stored callSid WITHOUT
 * a second Twilio call. Suppressed destinations return a non-error
 * sentinel { callSid: "suppressed" }.
 */
export async function placeVoiceCall(
  body: VoiceOutboundRequest | undefined,
): Promise<VoiceOutboundResult> {
  const keyParse = parseIdempotencyKey(body?.dedupeKey);
  if (!keyParse.ok) return keyParse;
  const dedupeHash = keyParse.key;

  // Idempotency replay BEFORE any work so a retry returns the prior id.
  const lookup = await lookupIdempotent<VoiceOutboundResult>("call", dedupeHash);
  if (lookup.hit) {
    log.info({ dedupeHash }, "Outbound voice idempotent replay");
    const cached = lookup.cachedValue;
    return {
      ...cached,
      headers: { ...(cached.headers ?? {}), "X-Idempotent-Replay": "true" },
    } as VoiceOutboundResult;
  }

  if (!body?.to) {
    return { ok: false, status: 400, body: { error: "missing 'to'" } };
  }
  if (typeof body.line !== "string" || body.line.trim().length === 0) {
    return { ok: false, status: 400, body: { error: "missing 'line'" } };
  }

  const phoneCheck = validateDialable(body.to);
  if (!phoneCheck.ok) {
    log.warn(
      { to: maskPhoneNumber(body.to), reason: phoneCheck.reason },
      "Outbound voice rejected — phone failed validation",
    );
    const result: VoiceOutboundResult = {
      ok: false,
      status: 400,
      body: { error: "invalid 'to'", details: phoneCheck.detail },
    };
    await storeIdempotent("call", dedupeHash, result, CALL_IDEMPOTENCY_TTL_SECONDS);
    return result;
  }

  const voice = resolveVoiceId(body.voiceId);
  if (!voice.ok) {
    if (voice.reason === "invalid") {
      const result: VoiceOutboundResult = {
        ok: false,
        status: 400,
        body: { error: "invalid 'voiceId'" },
      };
      await storeIdempotent("call", dedupeHash, result, CALL_IDEMPOTENCY_TTL_SECONDS);
      return result;
    }
    // unprovisioned — Doug's voice not wired up on this deploy. Operational
    // misconfig, NOT a property of the request, so don't cache it.
    log.error("voiceId 'doug-voice' requested but ELEVENLABS_VOICE_ID_DOUG is unset");
    return {
      ok: false,
      status: 500,
      body: { error: "voice_unconfigured", details: "doug-voice is not provisioned" },
    };
  }

  // Suppression: opted-out numbers are never called. Non-error sentinel
  // so the hub treats it as handled. Cached for replay consistency.
  if (await isSuppressed(body.to)) {
    log.info({ to: maskPhoneNumber(body.to) }, "Outbound voice suppressed (opted out)");
    const result: VoiceOutboundResult = {
      ok: true,
      status: 200,
      body: { callSid: "suppressed" },
    };
    await storeIdempotent("call", dedupeHash, result, CALL_IDEMPOTENCY_TTL_SECONDS);
    return result;
  }

  // Stash the line under a signed token Twilio will fetch via <Play>.
  const id = randomUUID();
  const token = signToken(id);
  try {
    await kv().set(
      voiceLineKvKey(id),
      JSON.stringify({ voiceId: voice.voiceId, line: body.line } satisfies PendingVoiceLine),
      env.voiceLineTtlSeconds,
    );
  } catch (err) {
    log.error({ err }, "Failed to stash voice line — refusing to place call");
    return { ok: false, status: 500, body: { error: "render_unavailable" } };
  }

  const playUrl = `https://${env.apiDomain}/call/voice-line?id=${encodeURIComponent(token)}`;
  const twimlStr =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Response>\n  <Play>${escapeXmlAttr(playUrl)}</Play>\n</Response>`;

  try {
    const { callSid } = await caller()({ to: body.to, voiceId: voice.voiceId, twiml: twimlStr });
    log.info({ callSid, to: maskPhoneNumber(body.to) }, "Outbound voice call placed");

    const result: VoiceOutboundResult = {
      ok: true,
      status: 200,
      body: { callSid },
      headers: dedupeHash ? { "X-Idempotent-Replay": "false" } : undefined,
    };
    await storeIdempotent("call", dedupeHash, result, CALL_IDEMPOTENCY_TTL_SECONDS);
    return result;
  } catch (err) {
    log.error({ err, to: maskPhoneNumber(body.to) }, "Failed to place outbound voice call");
    // Transient Twilio failures should be retryable on the same dedupeKey
    // — deliberately NOT cached.
    return {
      ok: false,
      status: 500,
      body: {
        error: "call_failed",
        details: err instanceof Error ? err.message : "unknown",
      },
    };
  }
}
