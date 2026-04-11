/**
 * core/outbound.ts — Framework-agnostic outbound-call initiation.
 *
 * Creates an outbound Twilio call that connects to the same
 * bidirectional WebSocket stream as inbound calls. Called from both
 * the Fastify handler and the Vercel serverless handler.
 */

import twilio from "twilio";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { buildOutboundTwiml } from "./twiml.js";
import { checkRateLimit, hashClientKey } from "./rateLimit.js";

const log = logger.child({ core: "outbound" });

// Singleton Twilio client — avoids recreating on every outbound call.
// On Vercel this is created once per serverless instance and reused
// across warm invocations.
const twilioClient = twilio(env.twilioAccountSid, env.twilioAuthToken);

export type OutboundRequest = {
  to?: string;
  role?: string;
};

export type OutboundResult =
  | {
      ok: true;
      status: 200;
      body: {
        success: true;
        callSid: string;
        to: string;
        role: string;
      };
    }
  | {
      ok: false;
      status: 400 | 401 | 429 | 500;
      body: {
        error: string;
        details?: string;
        retryAfterSeconds?: number;
      };
      /** Optional headers the adapter should set (e.g. Retry-After). */
      headers?: Record<string, string>;
    };

/**
 * Authorize an outbound request using the Bearer token in the
 * Authorization header. Returns null on success, or an OutboundResult
 * error to return to the caller.
 */
export function authorizeOutbound(
  authHeader: string | undefined,
): OutboundResult | null {
  if (!env.outboundApiKey) return null; // auth disabled
  if (!authHeader || authHeader !== `Bearer ${env.outboundApiKey}`) {
    return { ok: false, status: 401, body: { error: "Unauthorized" } };
  }
  return null;
}

/**
 * Rate-limit check keyed on the caller's API key (hashed). When the
 * Bearer token isn't set we key on a literal "anonymous" bucket, so
 * unauth'd local dev still gets a single shared budget — useful when
 * testing and not harmful in prod (prod always has the Bearer token).
 */
export async function checkOutboundRateLimit(
  authHeader: string | undefined,
): Promise<OutboundResult | null> {
  // Caller identity for rate-limit bucketing. Hash so the KV key
  // doesn't contain the raw secret.
  const rawKey = env.outboundApiKey
    ? (authHeader?.replace(/^Bearer\s+/i, "") ?? "anonymous")
    : "anonymous";
  const clientKey = hashClientKey(rawKey);

  const result = await checkRateLimit(clientKey, "outbound", {
    perMinute: env.outboundRateLimitPerMin,
    perHour: env.outboundRateLimitPerHour,
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
    "Outbound call rate-limited",
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
 * Initiate an outbound call. Validates input, authorizes, then calls
 * the Twilio REST API. Returns a structured result the caller
 * (Fastify or Vercel) maps to its HTTP response.
 */
export async function initiateOutboundCall(
  body: OutboundRequest | undefined,
): Promise<OutboundResult> {
  if (!body?.to) {
    return {
      ok: false,
      status: 400,
      body: { error: "Missing 'to' phone number" },
    };
  }

  const to = body.to;
  const role = body.role ?? "parent";
  const twimlStr = buildOutboundTwiml({ role });

  try {
    const call = await twilioClient.calls.create({
      to,
      from: env.twilioPhoneNumber,
      twiml: twimlStr,
      statusCallback: `https://${env.apiDomain}/call/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    log.info({ callSid: call.sid, to, role }, "Outbound call initiated");

    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        callSid: call.sid,
        to,
        role,
      },
    };
  } catch (err) {
    log.error({ err, to }, "Failed to initiate outbound call");
    return {
      ok: false,
      status: 500,
      body: {
        error: "Failed to initiate call",
        details: err instanceof Error ? err.message : "unknown",
      },
    };
  }
}
