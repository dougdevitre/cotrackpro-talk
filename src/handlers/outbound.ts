/**
 * handlers/outbound.ts — Outbound call initiation (Fastify adapter)
 *
 * Thin Fastify wrapper around src/core/outbound.ts. Vercel reuses the
 * same core in api/call/outbound.ts.
 *
 * POST /call/outbound
 *   body: { to: "+15551234567", role?: "parent" }
 */

import type { FastifyInstance } from "fastify";
import {
  authorizeOutbound,
  initiateOutboundCall,
  type OutboundRequest,
} from "../core/outbound.js";

export function registerOutboundRoutes(app: FastifyInstance): void {
  app.post("/call/outbound", async (request, reply) => {
    const authError = authorizeOutbound(request.headers.authorization);
    if (authError) {
      return reply.status(authError.status).send(authError.body);
    }

    const result = await initiateOutboundCall(
      request.body as OutboundRequest | undefined,
    );
    return reply.status(result.status).send(result.body);
  });
}
