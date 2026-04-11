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
  logIncomingCall,
  validateTwilioSignature,
} from "../../src/core/twiml.js";
import {
  parseBody,
  parseQuery,
  requireMethod,
  sendStatus,
  sendXml,
} from "../../src/core/httpAdapter.js";

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!requireMethod(req, res, "POST")) return;

  const body = await parseBody(req);
  const query = parseQuery(req);

  // Twilio signed the EXACT public URL it hit. Vercel's rewrite turns
  // the public "/call/incoming" into the internal "/api/call/incoming"
  // in req.url, so we must NOT read the path from req.url here —
  // hardcode the public path + preserve the original query string.
  const signature = req.headers["x-twilio-signature"] as string | undefined;
  const originalQuery = (req.url || "").split("?")[1];
  const fullUrl =
    `https://${env.apiDomain}/call/incoming` +
    (originalQuery ? `?${originalQuery}` : "");
  if (!validateTwilioSignature(signature, fullUrl, body)) {
    sendStatus(res, 403, "Forbidden");
    return;
  }

  const { from } = logIncomingCall(body);
  const role = query.role ?? "parent";
  const twiml = buildIncomingTwiml({ role, callerNumber: from });
  sendXml(res, 200, twiml);
}
