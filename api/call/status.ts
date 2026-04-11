/**
 * api/call/status.ts — Vercel serverless function
 *
 * POST /call/status — Twilio call status callback. Fire-and-forget
 * logging endpoint. Returns 204 on success, 403 on invalid Twilio
 * signature.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { env } from "../../src/config/env.js";
import {
  buildSignedWebhookUrl,
  logStatusCallback,
  validateTwilioSignature,
} from "../../src/core/twiml.js";
import {
  parseBody,
  requireMethod,
  sendStatus,
  stampRequestId,
} from "../../src/core/httpAdapter.js";

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  stampRequestId(req, res);
  if (!requireMethod(req, res, "POST")) return;

  const body = await parseBody(req);

  // Twilio signed the public path ("/call/status"); Vercel's rewrite
  // changes req.url to "/api/call/status", so we reconstruct the
  // public URL via buildSignedWebhookUrl (see M-2 in the code review).
  const signature = req.headers["x-twilio-signature"] as string | undefined;
  const fullUrl = buildSignedWebhookUrl(
    req.url,
    "/call/status",
    env.apiDomain,
  );
  if (!validateTwilioSignature(signature, fullUrl, body)) {
    sendStatus(res, 403, "Forbidden");
    return;
  }

  logStatusCallback(body);
  sendStatus(res, 204);
}
