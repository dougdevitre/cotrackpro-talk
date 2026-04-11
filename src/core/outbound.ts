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
      status: 400 | 401 | 500;
      body: { error: string; details?: string };
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
