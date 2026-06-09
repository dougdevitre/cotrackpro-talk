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
import { resolvePhone, sendAuthLink } from "../services/hub.js";
import { maskPhoneNumber } from "../services/dynamo.js";

const log = logger.child({ core: "twiml" });

/**
 * The line the assistant speaks when an unlinked caller has just been
 * sent a one-time sign-in link. Surfaced into the call via a TwiML
 * Stream <Parameter> and spoken by the call handler after the greeting.
 */
export const AUTH_LINK_NOTICE =
  "By the way — I just texted you a sign-in link. Tap it, sign in, " +
  "then call me back and I'll know it's you.";

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
  voiceId?: string;
  /** Clerk subject when the caller is a recognized signed-in user. */
  subject?: string;
  /** Line for the assistant to speak when a sign-in link was just sent. */
  authNotice?: string;
}): string {
  const role = normalizeRole(params.role);
  const wsUrl = `wss://${env.wsDomain}/call/stream`;
  const voiceIdParam = params.voiceId
    ? `\n      <Parameter name="voiceId" value="${escapeXmlAttr(params.voiceId)}" />`
    : "";
  const subjectParam = params.subject
    ? `\n      <Parameter name="subject" value="${escapeXmlAttr(params.subject)}" />`
    : "";
  const authNoticeParam = params.authNotice
    ? `\n      <Parameter name="authNotice" value="${escapeXmlAttr(params.authNotice)}" />`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXmlAttr(wsUrl)}">
      <Parameter name="role" value="${escapeXmlAttr(role)}" />
      <Parameter name="callerNumber" value="${escapeXmlAttr(params.callerNumber)}" />${voiceIdParam}${subjectParam}${authNoticeParam}
    </Stream>
  </Connect>
</Response>`;
}

/**
 * Recognize an inbound caller against the hub, and — if the caller isn't
 * linked yet — ask the hub to text them a one-time sign-in link.
 *
 * Returns the bits the TwiML needs:
 *   - `subject`    : set when the caller is a recognized signed-in user.
 *   - `authNotice` : set when we successfully triggered a sign-in SMS, so
 *                    the call handler can tell the caller to check their
 *                    phone.
 *
 * FAILS OPEN by design. The hub being down, slow, or unconfigured must
 * never block an inbound call: an unrecognized caller still reaches
 * crisis resources + anonymous help (that path is never gated behind
 * sign-in). So every non-`linked` / non-`sent` outcome simply returns
 * empty extras and the call proceeds anonymously.
 *
 * `from` must be the caller's E.164 number ("From"). When it's unknown
 * (e.g. blocked caller ID) we skip the hub entirely.
 */
export async function resolveInboundCaller(
  from: string | undefined,
): Promise<{ subject?: string; authNotice?: string }> {
  if (!from || from === "unknown" || !env.hubBaseUrl) return {};

  const masked = maskPhoneNumber(from);
  const resolved = await resolvePhone(from);

  if (resolved.status === "linked") {
    log.info({ from: masked }, "Inbound caller recognized (linked)");
    return { subject: resolved.subject };
  }

  if (resolved.status !== "not_linked") {
    // unauthorized / not_configured / invalid / error → proceed anonymous.
    log.warn(
      { from: masked, status: resolved.status },
      "resolve-phone non-success — proceeding as anonymous caller",
    );
    return {};
  }

  // Caller isn't linked → offer a sign-in link via the hub. Best-effort.
  const link = await sendAuthLink(from);
  if (link.status === "sent") {
    log.info({ from: masked }, "Sign-in link sent to unlinked caller");
    return { authNotice: AUTH_LINK_NOTICE };
  }

  log.warn(
    { from: masked, status: link.status },
    "send-auth-link non-success — proceeding as anonymous caller",
  );
  return {};
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
  // Mask the caller's number in the log line (PII) but return the raw
  // value — callers need the real E.164 to resolve the caller against the
  // hub. Mirrors the masking on the resolveInboundCaller / inbound-SMS
  // paths so no inbound surface logs a raw subscriber number.
  log.info({ from: maskPhoneNumber(from), callSid }, "Incoming call");
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
