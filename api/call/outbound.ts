/**
 * api/call/outbound.ts — Vercel serverless function (hub → talk seam)
 *
 * POST /api/call/outbound — Place a one-shot outbound voice call that
 *                           plays a single line in a named voice (e.g.
 *                           "doug-voice") and hangs up.
 *
 * Body: { to, voiceId, line, dedupeKey }
 * 200 -> { callSid }
 * Auth: shared hub↔talk Bearer (constant-time). Idempotent on dedupeKey.
 *       Rate-limited (per-min/hour + hard per-day cap) via KV.
 *
 * NOTE: this REPLACES the previous interactive {to, role} contract that
 * connected the callee to the Media Stream loop. That interactive path
 * now lives on the Fastify host at /call/outbound-interactive
 * (src/handlers/outbound.ts → src/core/outbound.ts).
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  authorizeVoiceOutbound,
  checkVoiceOutboundRateLimit,
  placeVoiceCall,
  type VoiceOutboundRequest,
  type VoiceOutboundResult,
} from "../../src/core/voiceOutbound.js";
import {
  parseBody,
  requireMethod,
  sendJson,
  stampRequestId,
} from "../../src/core/httpAdapter.js";

function sendResult(res: ServerResponse, result: VoiceOutboundResult): void {
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

  const authError = authorizeVoiceOutbound(req.headers.authorization);
  if (authError) {
    sendResult(res, authError);
    return;
  }

  const rateLimitError = await checkVoiceOutboundRateLimit(req.headers.authorization);
  if (rateLimitError) {
    sendResult(res, rateLimitError);
    return;
  }

  const body = (await parseBody(req)) as unknown as VoiceOutboundRequest | undefined;
  const result = await placeVoiceCall(body);
  sendResult(res, result);
}
