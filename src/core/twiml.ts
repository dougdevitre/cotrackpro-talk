/**
 * core/twiml.ts — Framework-agnostic TwiML + Twilio signature logic.
 *
 * These pure functions are called from both the Fastify handlers
 * (src/handlers/twiml.ts) and the Vercel serverless handlers
 * (api/call/incoming.ts, api/call/status.ts). They take plain inputs
 * and return plain outputs — no HTTP framework coupling.
 */

import twilio from "twilio";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { normalizeRole } from "./enumValidation.js";

const log = logger.child({ core: "twiml" });

/** Escape a string for safe use in an XML attribute value. */
export function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Whether Twilio signature validation is enabled via env. */
export function signatureValidationEnabled(): boolean {
  return env.validateTwilioSignature === "true";
}

/**
 * Validate a Twilio webhook signature. Returns true if valid (or if
 * validation is disabled). The caller is responsible for sending 403
 * on a false return.
 *
 * @param signature  x-twilio-signature header value
 * @param fullUrl    The full public URL Twilio hit, including protocol +
 *                   host + path + query (must match exactly what Twilio
 *                   signed — no trailing slash, no rewriting).
 * @param params     The parsed request body (application/x-www-form-urlencoded).
 */
export function validateTwilioSignature(
  signature: string | undefined,
  fullUrl: string,
  params: Record<string, string>,
): boolean {
  if (!signatureValidationEnabled()) return true;
  if (!signature) {
    log.warn({ fullUrl }, "Missing X-Twilio-Signature header");
    return false;
  }
  const ok = twilio.validateRequest(
    env.twilioAuthToken,
    signature,
    fullUrl,
    params,
  );
  if (!ok) log.warn({ fullUrl }, "Invalid Twilio signature");
  return ok;
}

/**
 * Build the TwiML response that Twilio receives when a call comes in.
 * Opens a bidirectional Media Stream to the WebSocket host.
 *
 * Unknown roles are normalized to "parent" with a warning log (H-3
 * in the code review) so a misconfigured Twilio webhook doesn't
 * propagate garbage into the call session.
 *
 * IMPORTANT: wsDomain must point at the long-running WebSocket host
 * (Fargate/Fly/Render), not Vercel. Vercel can't host this.
 */
export function buildIncomingTwiml(params: {
  role: string;
  callerNumber: string;
}): string {
  const role = normalizeRole(params.role);
  const wsUrl = `wss://${env.wsDomain}/call/stream`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXmlAttr(wsUrl)}">
      <Parameter name="role" value="${escapeXmlAttr(role)}" />
      <Parameter name="callerNumber" value="${escapeXmlAttr(params.callerNumber)}" />
    </Stream>
  </Connect>
</Response>`;
}

/**
 * Build the TwiML used for outbound calls. Same structure as incoming,
 * but tags the direction so the WS handler knows. Role is assumed to
 * already be normalized by the caller (`initiateOutboundCall` does
 * this) — passing it through normalizeRole here would be redundant.
 */
export function buildOutboundTwiml(params: { role: string }): string {
  const wsUrl = `wss://${env.wsDomain}/call/stream`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXmlAttr(wsUrl)}">
      <Parameter name="role" value="${escapeXmlAttr(params.role)}" />
      <Parameter name="direction" value="outbound" />
    </Stream>
  </Connect>
</Response>`;
}

/**
 * Log an incoming-call event. Pulled out so both the Fastify hook and
 * the Vercel handler log consistently.
 */
export function logIncomingCall(body: Record<string, string> | undefined): {
  from: string;
  callSid: string;
} {
  const from = body?.From ?? "unknown";
  const callSid = body?.CallSid ?? "unknown";
  log.info({ from, callSid }, "Incoming call");
  return { from, callSid };
}

/** Log a status callback event. */
export function logStatusCallback(
  body: Record<string, string> | undefined,
): void {
  log.info(
    {
      callSid: body?.CallSid,
      callStatus: body?.CallStatus,
      duration: body?.CallDuration,
    },
    "Call status update",
  );
}
