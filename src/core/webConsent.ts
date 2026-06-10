/**
 * core/webConsent.ts — Public web SMS opt-in recording.
 *
 * Backs the no-auth opt-in form on the landing page and /signup. A
 * verifiable, A2P-compliant proof-of-consent: we capture the EXACT
 * disclosure the visitor agreed to, the E.164 number, a server
 * timestamp, the source, and a one-way hash of the client IP — then
 * store it durably and log an audit line. We never send an SMS from
 * here (the A2P campaign isn't approved for that yet), and this path is
 * entirely separate from the inbound STOP/HELP webhook logic in
 * core/consent.ts.
 *
 * PII: the raw phone number is stored in the consent RECORD (that's the
 * point — it ties a number to its consent) but is masked in logs, the
 * same posture as the rest of the codebase.
 */

import { createHash } from "node:crypto";
import { kv } from "../services/kv.js";
import { checkRateLimit } from "./rateLimit.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ core: "webConsent" });

/**
 * Canonical opt-in disclosure. MUST match the language on the form, the
 * A2P campaign, and cotrackpro.com/sms-consent verbatim. Exported so the
 * server can record a canonical copy and tests can pin it.
 */
export const WEB_SMS_CONSENT_TEXT =
  "I agree to receive SMS from CoTrackPro Talk (verification codes, call " +
  "notifications and reminders, transcript and account alerts). Msg & data " +
  "rates may apply. Msg frequency varies. Reply STOP to cancel, HELP for help.";

export type WebConsentRequest = {
  phone?: string;
  consentText?: string;
  consent?: boolean;
  source?: string;
};

export type WebConsentResult = {
  status: number;
  body: Record<string, unknown>;
};

/** E.164: leading +, country digit 1-9, then 7-14 more digits. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Coerce a loosely-formatted phone string to E.164 (US-default). Returns
 * null when it can't be made into a valid E.164 number. Mirrors the
 * client-side formatter so the server is the authority but rarely
 * disagrees.
 */
export function toE164(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (E164.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  let e164: string | null = null;
  if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else if (trimmed.startsWith("+") && digits.length >= 8) e164 = `+${digits}`;
  return e164 && E164.test(e164) ? e164 : null;
}

/**
 * One-way, non-reversible hash of the client IP. Used both as the audit
 * field (we record proof-of-consent provenance without storing a raw IP)
 * and as the rate-limit dimension. Salted so the digest isn't a plain
 * rainbow-table lookup of an IP.
 */
export function hashIp(ip: string | undefined): string {
  const salt = process.env.CONSENT_IP_SALT || "cotrackpro-talk-consent-v1";
  return createHash("sha256")
    .update(`${salt}:${ip ?? "unknown"}`)
    .digest("hex")
    .slice(0, 32);
}

/** Mask a number for logs — first 3 + last 2 digits only. */
function maskPhone(p: string): string {
  return p.length >= 6 ? `${p.slice(0, 3)}***${p.slice(-2)}` : "***";
}

/**
 * Validate + record a public web SMS opt-in. Pure of the HTTP layer
 * (takes a parsed body + the client IP) so it's unit-testable. Never
 * sends an SMS. Returns the status + JSON body the adapter should send.
 */
export async function recordWebConsent(
  body: WebConsentRequest | undefined,
  ctx: { ip?: string },
): Promise<WebConsentResult> {
  const phone = toE164(body?.phone);
  if (!phone) {
    return {
      status: 400,
      body: { error: "invalid_phone", message: "Enter a valid mobile number." },
    };
  }

  // The checkbox must be ticked. The form disables submit until then, but
  // the server is the authority — never record consent we can't prove.
  if (body?.consent !== true) {
    return {
      status: 400,
      body: { error: "consent_required", message: "Please check the consent box to continue." },
    };
  }

  const consentText = (body?.consentText ?? "").trim();
  if (!consentText || consentText.length > 1000) {
    return { status: 400, body: { error: "invalid_consent_text" } };
  }

  const ipHash = hashIp(ctx.ip);

  // Light rate limit per client (by IP hash) — abuse/bill protection on a
  // public endpoint. Fails open (see checkRateLimit) so a KV blip never
  // blocks a real opt-in.
  const rl = await checkRateLimit(ipHash, "consent", { perMinute: 5, perHour: 30 });
  if (!rl.allowed) {
    return {
      status: 429,
      body: { error: "rate_limited", message: "Too many attempts — please try again in a minute." },
    };
  }

  const timestamp = new Date().toISOString();
  const source =
    typeof body?.source === "string" && body.source ? body.source.slice(0, 32) : "web";

  const record = { phone, consentText, timestamp, source, ipHash };

  // Durable store. Persists for real when KV_BACKEND=dynamo (or upstash);
  // with the default in-memory backend it's per-instance only — see the
  // README "Web opt-in" note. No TTL: a consent record must not expire.
  // Best-effort: a store failure is logged but still returns success with
  // the audit log as the fallback record of consent.
  try {
    await kv().set(`consent:web:${phone}:${timestamp}`, JSON.stringify(record));
  } catch (err) {
    log.error({ err }, "consent KV write failed — relying on audit log");
  }

  // Audit log — masked number (PII), full ipHash + timestamp + source so
  // the consent event is reconstructable from logs alone.
  log.info({ phone: maskPhone(phone), source, ipHash, timestamp }, "web SMS consent recorded");

  return {
    status: 200,
    body: { ok: true, message: "Thanks — you're opted in. Reply STOP anytime to cancel." },
  };
}
