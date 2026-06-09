/**
 * handlers/outbound.ts — Interactive outbound call initiation (Fastify).
 *
 * Thin Fastify wrapper around src/core/outbound.ts. This is the
 * INTERACTIVE variant: it dials a number and connects the callee to the
 * bidirectional Media Stream voice loop.
 *
 * POST /call/outbound-interactive
 *   body: { to: "+15551234567", role?: "parent" }
 *
 * NOTE: the public Vercel path /call/outbound is now the hub's one-shot
 * voice contract ({ to, voiceId, line, dedupeKey }, see
 * api/call/outbound.ts + src/core/voiceOutbound.ts). This interactive
 * path was relocated off /call/outbound to avoid colliding with that
 * contract.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  authorizeOutbound,
  checkOutboundRateLimit,
  initiateOutboundCall,
  type OutboundRequest,
  type OutboundResult,
} from "../core/outbound.js";

function sendResult(reply: FastifyReply, result: OutboundResult): FastifyReply {
  if (!result.ok && result.headers) {
    for (const [k, v] of Object.entries(result.headers)) {
      reply.header(k, v);
    }
  }
  return reply.status(result.status).send(result.body);
}

export function registerOutboundRoutes(app: FastifyInstance): void {
  app.post("/call/outbound-interactive", async (request, reply) => {
    const { result: authError, userId } = await authorizeOutbound(request.headers.authorization);
    if (authError) return sendResult(reply, authError);
    // Attach Clerk userId to request for downstream use (call records)
    if (userId) (request as typeof request & { clerkUserId?: string }).clerkUserId = userId;

    const rateLimitError = await checkOutboundRateLimit(
      request.headers.authorization,
    );
    if (rateLimitError) return sendResult(reply, rateLimitError);

    // Idempotency-Key is forwarded to initiateOutboundCall which
    // handles lookup + cache on its own. Fastify lowercases header
    // names by default so this is the canonical form.
    const idempotencyKey = request.headers["idempotency-key"] as
      | string
      | string[]
      | undefined;
    const result = await initiateOutboundCall(
      request.body as OutboundRequest | undefined,
      idempotencyKey,
    );
    return sendResult(reply, result);
  });
}
