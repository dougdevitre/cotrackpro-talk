/**
 * handlers/records.ts — REST API for call record CRUD (Fastify adapter)
 *
 * Thin Fastify wrapper around src/core/records.ts. Vercel reuses the
 * same core in api/records/*.ts.
 *
 * GET    /records/:callSid       — Get a single call record
 * GET    /records                — List recent calls (paginated)
 * GET    /records/by-role/:role  — List calls by role (+ optional date filter)
 * GET    /records/by-status/:status — List calls by status
 * DELETE /records/:callSid       — Delete a call record
 *
 * All endpoints require Bearer token auth (same OUTBOUND_API_KEY).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  authorizeRecords,
  checkRecordsRateLimit,
  deleteRecord,
  getRecord,
  listRecords,
  listRecordsByRole,
  listRecordsByStatus,
  type RecordResult,
} from "../core/records.js";

function send<T>(reply: FastifyReply, result: RecordResult<T>): FastifyReply {
  // 429 responses carry headers (Retry-After) that must be set before
  // .send() is called. The same applies to any future error variant
  // that wants to advertise metadata via HTTP headers.
  if (!result.ok && result.headers) {
    for (const [k, v] of Object.entries(result.headers)) {
      reply.header(k, v);
    }
  }
  if (result.status === 204) return reply.status(204).send();
  return reply.status(result.status).send(result.body);
}

export function registerRecordRoutes(app: FastifyInstance): void {
  // ── Auth + rate-limit hook for all /records routes ────────────────
  // Order matters: auth rejects unauthenticated requests BEFORE they
  // touch the KV rate limiter, so a flood of unauth'd garbage can't
  // chew through the authenticated caller's rate budget.
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/records")) return;
    const authError = await authorizeRecords(request.headers.authorization);
    if (authError) {
      return reply.status(authError.status).send(authError.body);
    }
    const rateLimitError = await checkRecordsRateLimit<unknown>(
      request.headers.authorization,
    );
    if (rateLimitError) {
      return send(reply, rateLimitError);
    }
  });

  app.get("/records/:callSid", async (request, reply) => {
    const { callSid } = request.params as { callSid: string };
    return send(reply, await getRecord(callSid));
  });

  app.get("/records", async (request, reply) => {
    return send(reply, await listRecords(request.query as { limit?: string; cursor?: string }));
  });

  app.get("/records/by-role/:role", async (request, reply) => {
    const { role } = request.params as { role: string };
    return send(
      reply,
      await listRecordsByRole(
        role,
        request.query as {
          startDate?: string;
          endDate?: string;
          limit?: string;
          cursor?: string;
        },
      ),
    );
  });

  app.get("/records/by-status/:status", async (request, reply) => {
    const { status } = request.params as { status: string };
    return send(
      reply,
      await listRecordsByStatus(
        status,
        request.query as {
          startDate?: string;
          endDate?: string;
          limit?: string;
          cursor?: string;
        },
      ),
    );
  });

  app.delete("/records/:callSid", async (request, reply) => {
    const { callSid } = request.params as { callSid: string };
    return send(reply, await deleteRecord(callSid));
  });
}
