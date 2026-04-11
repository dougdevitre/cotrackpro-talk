/**
 * api/call/outbound.ts — Vercel serverless function
 *
 * POST /call/outbound  — Initiate an outbound Twilio call that
 *                        connects to the Media Stream WebSocket on
 *                        WS_DOMAIN.
 *
 * Body: { to: "+15551234567", role?: "parent" }
 * Auth: Bearer token when OUTBOUND_API_KEY is set.
 * Rate limits: per-minute and per-hour fixed windows, enforced via KV
 *              (shared across Vercel + long-running host when
 *              KV_URL/KV_TOKEN are configured).
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  authorizeOutbound,
  checkOutboundRateLimit,
  initiateOutboundCall,
  type OutboundRequest,
  type OutboundResult,
} from "../../src/core/outbound.js";
import {
  parseBody,
  requireMethod,
  sendJson,
  stampRequestId,
} from "../../src/core/httpAdapter.js";

function sendResult(res: ServerResponse, result: OutboundResult): void {
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

  const authError = authorizeOutbound(req.headers.authorization);
  if (authError) {
    sendResult(res, authError);
    return;
  }

  const rateLimitError = await checkOutboundRateLimit(
    req.headers.authorization,
  );
  if (rateLimitError) {
    sendResult(res, rateLimitError);
    return;
  }

  // Idempotency-Key is forwarded to initiateOutboundCall which
  // handles lookup + cache on its own. Node's IncomingMessage
  // lowercases header names.
  const idempotencyKey = req.headers["idempotency-key"];
  const body = (await parseBody(req)) as unknown as OutboundRequest | undefined;
  const result = await initiateOutboundCall(body, idempotencyKey);
  sendResult(res, result);
}
