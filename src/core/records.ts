/**
 * core/records.ts — Framework-agnostic call-record query operations.
 *
 * Wraps the DynamoDB service with auth, cursor encoding/decoding, and
 * input validation, returning structured results the Fastify and
 * Vercel handlers can translate directly into HTTP responses.
 */

import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { CoTrackProRole, CallStatus, CallRecord } from "../types/index.js";
import {
  getCallRecord,
  listRecentCalls,
  listCallsByRole,
  listCallsByStatus,
  deleteCallRecord,
} from "../services/dynamo.js";

const log = logger.child({ core: "records" });

export type RecordResult<T> =
  | { ok: true; status: 200 | 204; body: T | null }
  | { ok: false; status: 400 | 401 | 404 | 500; body: { error: string } };

export type ListResult = {
  records: CallRecord[];
  cursor: string | null;
};

/** Bearer-token auth check shared by all records endpoints. */
export function authorizeRecords(
  authHeader: string | undefined,
): { ok: false; status: 401; body: { error: string } } | null {
  if (!env.outboundApiKey) return null;
  if (!authHeader || authHeader !== `Bearer ${env.outboundApiKey}`) {
    return { ok: false, status: 401, body: { error: "Unauthorized" } };
  }
  return null;
}

function encodeCursor(lastKey: Record<string, unknown> | undefined): string | null {
  if (!lastKey) return null;
  return Buffer.from(JSON.stringify(lastKey)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    return undefined;
  }
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** GET /records/:callSid */
export async function getRecord(
  callSid: string | undefined,
): Promise<RecordResult<CallRecord>> {
  if (!callSid) {
    return { ok: false, status: 400, body: { error: "Missing callSid" } };
  }
  const record = await getCallRecord(callSid);
  if (!record) {
    return { ok: false, status: 404, body: { error: "Call record not found" } };
  }
  return { ok: true, status: 200, body: record };
}

/** GET /records */
export async function listRecords(query: {
  limit?: string;
  cursor?: string;
}): Promise<RecordResult<ListResult>> {
  const limit = parseLimit(query.limit, 25);
  const lastKey = decodeCursor(query.cursor);
  const result = await listRecentCalls({ limit, lastKey });
  return {
    ok: true,
    status: 200,
    body: {
      records: result.records,
      cursor: encodeCursor(result.lastKey),
    },
  };
}

/** GET /records/by-role/:role */
export async function listRecordsByRole(
  role: string | undefined,
  query: {
    startDate?: string;
    endDate?: string;
    limit?: string;
    cursor?: string;
  },
): Promise<RecordResult<ListResult>> {
  if (!role) {
    return { ok: false, status: 400, body: { error: "Missing role" } };
  }
  const limit = parseLimit(query.limit, 50);
  const lastKey = decodeCursor(query.cursor);
  const result = await listCallsByRole(role as CoTrackProRole, {
    startDate: query.startDate,
    endDate: query.endDate,
    limit,
    lastKey,
  });
  return {
    ok: true,
    status: 200,
    body: {
      records: result.records,
      cursor: encodeCursor(result.lastKey),
    },
  };
}

/** GET /records/by-status/:status */
export async function listRecordsByStatus(
  status: string | undefined,
  query: {
    startDate?: string;
    endDate?: string;
    limit?: string;
    cursor?: string;
  },
): Promise<RecordResult<ListResult>> {
  if (!status) {
    return { ok: false, status: 400, body: { error: "Missing status" } };
  }
  const limit = parseLimit(query.limit, 50);
  const lastKey = decodeCursor(query.cursor);
  const result = await listCallsByStatus(status as CallStatus, {
    startDate: query.startDate,
    endDate: query.endDate,
    limit,
    lastKey,
  });
  return {
    ok: true,
    status: 200,
    body: {
      records: result.records,
      cursor: encodeCursor(result.lastKey),
    },
  };
}

/** DELETE /records/:callSid */
export async function deleteRecord(
  callSid: string | undefined,
): Promise<RecordResult<null>> {
  if (!callSid) {
    return { ok: false, status: 400, body: { error: "Missing callSid" } };
  }
  const deleted = await deleteCallRecord(callSid);
  if (!deleted) {
    return { ok: false, status: 404, body: { error: "Call record not found" } };
  }
  log.info({ callSid }, "Call record deleted via API");
  return { ok: true, status: 204, body: null };
}
