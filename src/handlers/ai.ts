/**
 * handlers/ai.ts — Fastify adapter for POST /api/ai/complete
 *
 * Thin wrapper around src/core/ai.ts. The Vercel adapter in
 * api/ai/complete.ts reuses the same core.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  completeAi,
  type AiCompleteRequest,
  type AiCompleteResult,
} from "../core/ai.js";
import { corsHeaders } from "../core/cors.js";

function applyCors(request: FastifyRequest, reply: FastifyReply): void {
  const headers = corsHeaders(request.headers.origin as string | undefined);
  for (const [k, v] of Object.entries(headers)) reply.header(k, v);
}

function sendResult(reply: FastifyReply, result: AiCompleteResult): FastifyReply {
  if (!result.ok && result.headers) {
    for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
  }
  return reply.status(result.status).send(result.body);
}

export function registerAiRoutes(app: FastifyInstance): void {
  app.options("/api/ai/complete", async (request, reply) => {
    applyCors(request, reply);
    reply.status(204).send();
  });

  app.post("/api/ai/complete", async (request, reply) => {
    applyCors(request, reply);
    const result = await completeAi(
      request.headers.authorization,
      request.body as AiCompleteRequest | undefined,
    );
    return sendResult(reply, result);
  });
}
