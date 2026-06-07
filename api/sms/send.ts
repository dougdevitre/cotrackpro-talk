/**
 * api/sms/send.ts — Vercel serverless function (hub → talk seam)
 *
 * POST /api/sms/send  — Send a hub-composed SMS through our Twilio number.
 *
 * Body: { to, body, dedupeKey }
 * Auth: shared hub↔talk Bearer token (OUTBOUND_API_KEY), verified
 *       constant-time. Idempotent on dedupeKey. Rate-limited via KV.
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  authorizeInboundSms,
  checkSmsRateLimit,
  sendSms,
  type SmsRequest,
  type SmsResult,
} from "../../src/core/sms.js";
import {
  parseBody,
  requireMethod,
  sendJson,
  stampRequestId,
} from "../../src/core/httpAdapter.js";

function sendResult(res: ServerResponse, result: SmsResult): void {
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  }
  sendJson(res, result.status, result.body);
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  stampRequestId(req, res);
  if (!requireMethod(req, res, "POST")) return;

  const authError = authorizeInboundSms(req.headers.authorization);
  if (authError) {
    sendResult(res, authError);
    return;
  }

  const rateLimitError = await checkSmsRateLimit(req.headers.authorization);
  if (rateLimitError) {
    sendResult(res, rateLimitError);
    return;
  }

  const body = (await parseBody(req)) as unknown as SmsRequest | undefined;
  const result = await sendSms(body);
  sendResult(res, result);
}
