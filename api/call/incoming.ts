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
  validateTwilioSignature,
} from "../../src/core/twiml.js";
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

  const { from } = logIncomingCall(body);
  const role = query.role ?? "parent";
  const twiml = buildIncomingTwiml({ role, callerNumber: from });
  sendXml(res, 200, twiml);
}
