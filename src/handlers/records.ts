/**
 * handlers/records.ts — REST API for call record CRUD
 *
 * GET    /records/:callSid       — Get a single call record
 * GET    /records                — List recent calls (paginated)
 * GET    /records/by-role/:role  — List calls by role (+ optional date filter)
 * GET    /records/by-status/:status — List calls by status
 * DELETE /records/:callSid       — Delete a call record
 *
 * All endpoints require Bearer token auth (same OUTBOUND_API_KEY).
 */

import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { CoTrackProRole, CallStatus } from "../types/index.js";
import {
  getCallRecord,
  listRecentCalls,
  listCallsByRole,
  listCallsByStatus,
  deleteCallRecord,
} from "../services/dynamo.js";

const log = logger.child({ handler: "records" });

export function registerRecordRoutes(app: FastifyInstance): void {
  // ── Auth hook for all /records routes ──────────────────────────────────
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/records")) return;

    if (env.outboundApiKey) {
      const auth = request.headers.authorization;
      if (!auth || auth !== `Bearer ${env.outboundApiKey}`) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    }
  });

  // ── GET /records/:callSid ─────────────────────────────────────────────
  app.get("/records/:callSid", async (request, reply) => {
    const { callSid } = request.params as { callSid: string };

    if (!callSid) {
      return reply.status(400).send({ error: "Missing callSid" });
    }

    const record = await getCallRecord(callSid);

    if (!record) {
      return reply.status(404).send({ error: "Call record not found" });
    }

    return reply.send(record);
  });

  // ── GET /records ──────────────────────────────────────────────────────
  app.get("/records", async (request, reply) => {
    const query = request.query as {
      limit?: string;
      cursor?: string;
    };

    const limit = query.limit ? parseInt(query.limit, 10) : 25;
    const lastKey = query.cursor
      ? JSON.parse(Buffer.from(query.cursor, "base64url").toString())
      : undefined;

    const result = await listRecentCalls({ limit, lastKey });

    return reply.send({
      records: result.records,
      cursor: result.lastKey
        ? Buffer.from(JSON.stringify(result.lastKey)).toString("base64url")
        : null,
    });
  });

  // ── GET /records/by-role/:role ────────────────────────────────────────
  app.get("/records/by-role/:role", async (request, reply) => {
    const { role } = request.params as { role: string };
    const query = request.query as {
      startDate?: string;
      endDate?: string;
      limit?: string;
      cursor?: string;
    };

    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const lastKey = query.cursor
      ? JSON.parse(Buffer.from(query.cursor, "base64url").toString())
      : undefined;

    const result = await listCallsByRole(role as CoTrackProRole, {
      startDate: query.startDate,
      endDate: query.endDate,
      limit,
      lastKey,
    });

    return reply.send({
      records: result.records,
      cursor: result.lastKey
        ? Buffer.from(JSON.stringify(result.lastKey)).toString("base64url")
        : null,
    });
  });

  // ── GET /records/by-status/:status ────────────────────────────────────
  app.get("/records/by-status/:status", async (request, reply) => {
    const { status } = request.params as { status: string };
    const query = request.query as {
      startDate?: string;
      endDate?: string;
      limit?: string;
      cursor?: string;
    };

    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const lastKey = query.cursor
      ? JSON.parse(Buffer.from(query.cursor, "base64url").toString())
      : undefined;

    const result = await listCallsByStatus(status as CallStatus, {
      startDate: query.startDate,
      endDate: query.endDate,
      limit,
      lastKey,
    });

    return reply.send({
      records: result.records,
      cursor: result.lastKey
        ? Buffer.from(JSON.stringify(result.lastKey)).toString("base64url")
        : null,
    });
  });

  // ── DELETE /records/:callSid ──────────────────────────────────────────
  app.delete("/records/:callSid", async (request, reply) => {
    const { callSid } = request.params as { callSid: string };

    if (!callSid) {
      return reply.status(400).send({ error: "Missing callSid" });
    }

    const deleted = await deleteCallRecord(callSid);

    if (!deleted) {
      return reply.status(404).send({ error: "Call record not found" });
    }

    log.info({ callSid }, "Call record deleted via API");
    return reply.status(204).send();
  });
}
