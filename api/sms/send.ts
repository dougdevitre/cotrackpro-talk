/**
 * api/sms/send.ts — Vercel serverless function
 *
 * POST /api/sms/send  — Deliver an SMS (phone-link OTP) via the voice
 *                       surface's Twilio number. Called by the CoTrackPro
 *                       hub's phone↔account-linking flow.
 *
 * Body: { to: "+15551234567", body: "Your code is 123456", dedupeKey: "..." }
 * Auth: Bearer OUTBOUND_API_KEY (the shared talk bearer; same token
 *       /call/outbound requires).
 * Idempotency: the body's `dedupeKey` is used as the idempotency key so a
 *       hub retry never sends the same code twice.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { authorizeOutbound } from "../../src/core/outbound.js";
import {
  checkSmsRateLimit,
  sendSms,
  type SmsRequest,
} from "../../src/core/sms.js";
import {
  parseBody,
  requireMethod,
  sendJson,
  stampRequestId,
} from "../../src/core/httpAdapter.js";

/**
 * Structural result type shared by SmsResult and the OutboundResult
 * auth-error variants (both are `{ ok, status, body, headers? }`), so
 * the auth 401/500 can flow through the same sender without a cast.
 */
type HttpResult = {
  ok: boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

function sendResult(res: ServerResponse, result: HttpResult): void {
  if (!result.ok && result.headers) {
    for (const [k, v] of Object.entries(result.headers)) {
      res.setHeader(k, v);
    }
  }
  sendJson(res, result.status, result.body);
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  stampRequestId(req, res);
  if (!requireMethod(req, res, "POST")) return;

  // Same bearer as /call/outbound — the hub authenticates with the
  // shared talk token. authorizeOutbound fails closed in production.
  const { result: authError } = await authorizeOutbound(req.headers.authorization);
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
