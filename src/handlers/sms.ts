/**
 * handlers/sms.ts — SMS (OTP) delivery (Fastify adapter)
 *
 * Thin Fastify wrapper around src/core/sms.ts. Vercel reuses the same
 * core in api/sms/send.ts.
 *
 * POST /api/sms/send
 *   body: { to: "+15551234567", body: "Your code is 123456", dedupeKey: "..." }
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { authorizeOutbound } from "../core/outbound.js";
import {
  checkSmsRateLimit,
  sendSms,
  type SmsRequest,
} from "../core/sms.js";

/**
 * Structural result type shared by SmsResult and the OutboundResult
 * auth-error variants — both are `{ ok, status, body, headers? }`.
 */
type HttpResult = {
  ok: boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

function sendResult(reply: FastifyReply, result: HttpResult): FastifyReply {
  if (!result.ok && result.headers) {
    for (const [k, v] of Object.entries(result.headers)) {
      reply.header(k, v);
    }
  }
  return reply.status(result.status).send(result.body);
}

export function registerSmsRoutes(app: FastifyInstance): void {
  app.post("/api/sms/send", async (request, reply) => {
    // Same bearer as /call/outbound — the hub authenticates with the
    // shared talk token.
    const { result: authError } = await authorizeOutbound(
      request.headers.authorization,
    );
    if (authError) return sendResult(reply, authError);

    const rateLimitError = await checkSmsRateLimit(
      request.headers.authorization,
    );
    if (rateLimitError) return sendResult(reply, rateLimitError);

    const result = await sendSms(request.body as SmsRequest | undefined);
    return sendResult(reply, result);
  });
}
