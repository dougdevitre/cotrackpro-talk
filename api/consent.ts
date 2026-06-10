/**
 * api/consent.ts — Vercel serverless function
 *
 * POST /api/consent — Public, no-auth SMS opt-in from the web form
 * (landing page + /signup). Records a verifiable proof-of-consent and
 * returns 200. Never sends an SMS. See src/core/webConsent.ts.
 *
 * Body: { phone, consentText, consent: true, source }
 * The server derives the timestamp and the IP hash itself.
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  recordWebConsent,
  type WebConsentRequest,
} from "../src/core/webConsent.js";
import {
  parseBody,
  requireMethod,
  sendJson,
  stampRequestId,
} from "../src/core/httpAdapter.js";

/** First hop of x-forwarded-for (the real client) behind Vercel's proxy. */
function clientIp(req: IncomingMessage): string | undefined {
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || undefined;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  stampRequestId(req, res);
  if (!requireMethod(req, res, "POST")) return;

  const body = (await parseBody(req)) as unknown as WebConsentRequest | undefined;
  const result = await recordWebConsent(body, { ip: clientIp(req) });
  sendJson(res, result.status, result.body);
}
