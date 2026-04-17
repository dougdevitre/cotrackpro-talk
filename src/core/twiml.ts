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

/** Whether Twilio signature validation is enabled.
 *
 * In production, validation is ALWAYS on regardless of the env var —
 * leaving it off in prod lets anyone POST forged Twilio webhooks to
 * /call/incoming and /call/status, which can spoof call status, return
 * arbitrary TwiML, and amplify into Anthropic + ElevenLabs cost via
 * downstream stream sessions. Outside production we honor the env var
 * so local dev / test environments can run without real Twilio creds.
 */
export function signatureValidationEnabled(): boolean {
  if (env.nodeEnv === "production") return true;
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
 * Reconstruct the EXACT public URL Twilio signed, ignoring whatever
 * the framework has rewritten `req.url` into.
 *
 * Why this helper exists: on Vercel, a rewrite in `vercel.json` maps
 * the public path `/call/incoming` to the internal file-based route
 * `/api/call/incoming`. By the time our handler sees the request,
 * `req.url` has already been rewritten to the internal path. But
 * Twilio signed the ORIGINAL public path, so reconstructing the URL
 * from `req.url` would produce a different string and the signature
 * check would fail.
 *
 * We fix this by taking the public path as a parameter — hardcoded
 * in each Vercel handler — and splicing on only the query string
 * from `req.url`. The path portion of `req.url` is deliberately
 * ignored.
 *
 * Flagged as M-2 in docs/CODE_REVIEW-vercel-hosting-optimization.md.
 * This helper is the single place to regression-test the behavior
 * so a future refactor that tries to be "cleaner" by reading
 * `req.url` directly gets caught by unit tests.
 *
 * @param reqUrl       The raw `req.url` from the Node HTTP request.
 *                     May be rewritten (e.g. "/api/call/incoming?role=x")
 *                     or the public path ("/call/incoming?role=x") in
 *                     single-host mode. The path portion is DISCARDED.
 * @param publicPath   The public path Twilio signed (must begin with
 *                     "/"), e.g. "/call/incoming".
 * @param apiDomain    The public domain Twilio was pointed at, e.g.
 *                     env.apiDomain. No scheme prefix — we always use
 *                     https since Twilio requires it.
 */
export function buildSignedWebhookUrl(
  reqUrl: string | undefined,
  publicPath: string,
  apiDomain: string,
): string {
  const queryIdx = (reqUrl ?? "").indexOf("?");
  const query = queryIdx >= 0 ? (reqUrl as string).slice(queryIdx + 1) : "";
  return `https://${apiDomain}${publicPath}${query ? `?${query}` : ""}`;
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
