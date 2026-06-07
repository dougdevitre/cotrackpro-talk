/**
 * handlers/sms.ts — SMS send (Fastify adapter, hub → talk seam)
 *
 * Thin Fastify wrapper around src/core/sms.ts. Vercel reuses the same
 * core in api/sms/send.ts.
 *
 * POST /api/sms/send
 *   body: { to, body, dedupeKey }
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  authorizeInboundSms,
  checkSmsRateLimit,
  sendSms,
  type SmsRequest,
  type SmsResult,
} from "../core/sms.js";

function sendResult(reply: FastifyReply, result: SmsResult): FastifyReply {
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
  }
  return reply.status(result.status).send(result.body);
}

export function registerSmsRoutes(app: FastifyInstance): void {
  app.post("/api/sms/send", async (request, reply) => {
    const authError = authorizeInboundSms(request.headers.authorization);
    if (authError) return sendResult(reply, authError);

    const rateLimitError = await checkSmsRateLimit(request.headers.authorization);
    if (rateLimitError) return sendResult(reply, rateLimitError);

    const result = await sendSms(request.body as SmsRequest | undefined);
    return sendResult(reply, result);
  });
}
