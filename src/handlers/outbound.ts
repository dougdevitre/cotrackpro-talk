/**
 * handlers/outbound.ts — Outbound call initiation (Fastify adapter)
 *
 * Thin Fastify wrapper around src/core/outbound.ts. Vercel reuses the
 * same core in api/call/outbound.ts.
 *
 * POST /call/outbound
 *   body: { to: "+15551234567", role?: "parent" }
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
  app.post("/call/outbound", async (request, reply) => {
    const authError = authorizeOutbound(request.headers.authorization);
    if (authError) return sendResult(reply, authError);

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
