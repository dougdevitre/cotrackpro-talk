/**
 * api/call/outbound.ts — Vercel serverless function
 *
 * POST /call/outbound  — Initiate an outbound Twilio call that
 *                        connects to the Media Stream WebSocket on
 *                        WS_DOMAIN.
 *
 * Body: { to: "+15551234567", role?: "parent" }
 * Auth: Bearer token when OUTBOUND_API_KEY is set.
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  authorizeOutbound,
  initiateOutboundCall,
  type OutboundRequest,
} from "../../src/core/outbound.js";
import {
  parseBody,
  requireMethod,
  sendJson,
} from "../../src/core/httpAdapter.js";

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!requireMethod(req, res, "POST")) return;

  const authError = authorizeOutbound(req.headers.authorization);
  if (authError) {
    sendJson(res, authError.status, authError.body);
    return;
  }

  const body = (await parseBody(req)) as unknown as OutboundRequest | undefined;
  const result = await initiateOutboundCall(body);
  sendJson(res, result.status, result.body);
}
