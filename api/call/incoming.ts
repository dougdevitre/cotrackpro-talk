/**
 * api/call/incoming.ts — Vercel serverless function
 *
 * POST /call/incoming  — Twilio webhook → returns TwiML that starts
 *                        a bidirectional media stream to the WS host.
 *
 * The TwiML returned here points <Stream url="..."> at WS_DOMAIN, which
 * MUST be a long-running host (Fargate/Fly/Render). Vercel can't serve
 * the WebSocket itself; this function only builds and returns the TwiML.
 *
 * Runs on Vercel's Node runtime. Uses the framework-agnostic core in
 * src/core/twiml.ts, which is the same code path Fastify uses.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { env } from "../../src/config/env.js";
import {
  buildIncomingTwiml,
  buildSignedWebhookUrl,
  logIncomingCall,
  resolveInboundCaller,
  validateTwilioSignature,
} from "../../src/core/twiml.js";
import { lookupInboundPhone } from "../../src/config/inboundPhoneMap.js";
import { logger } from "../../src/utils/logger.js";
import {
  parseBody,
  parseQuery,
  requireMethod,
  sendStatus,
  sendXml,
  stampRequestId,
} from "../../src/core/httpAdapter.js";

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  stampRequestId(req, res);
  if (!requireMethod(req, res, "POST")) return;

  const body = await parseBody(req);
  const query = parseQuery(req);

  // Twilio signed the EXACT public URL it hit. Vercel's rewrite turns
  // the public "/call/incoming" into the internal "/api/call/incoming"
  // in req.url, so we MUST NOT read the path from req.url — we hardcode
  // the public path and splice on the original query string via
  // buildSignedWebhookUrl. See src/core/twiml.ts for the rationale
  // and docs/CODE_REVIEW-vercel-hosting-optimization.md M-2.
  const signature = req.headers["x-twilio-signature"] as string | undefined;
  const fullUrl = buildSignedWebhookUrl(
    req.url,
    "/call/incoming",
    env.apiDomain,
  );
  if (!validateTwilioSignature(signature, fullUrl, body)) {
    sendStatus(res, 403, "Forbidden");
    return;
  }

  const { from, callSid } = logIncomingCall(body);
  // Per-phone override: if INBOUND_PHONE_VOICE_MAP contains an entry
  // for the Twilio "To" number, it wins over the ?role= query param
  // and pins both the persona and the ElevenLabs voice for this call.
  const entry = lookupInboundPhone(body?.To);
  const role = entry?.role ?? query.role ?? "parent";
  const voiceId = entry?.voiceId;
  if (entry) {
    logger.info(
      { callSid, to: body?.To, role, voiceId },
      "Inbound phone map match",
    );
  }
  // Recognize the caller against the hub (and text an unlinked caller a
  // sign-in link). Fails open — an unrecognized caller still gets through
  // as anonymous and reaches crisis resources + anonymous help.
  const { subject, authNotice } = await resolveInboundCaller(from);

  const twiml = buildIncomingTwiml({
    role,
    callerNumber: from,
    voiceId,
    subject,
    authNotice,
  });
  sendXml(res, 200, twiml);
}
