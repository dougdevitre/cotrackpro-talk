/**
 * core/records.ts — Framework-agnostic call-record query operations.
 *
 * Wraps the DynamoDB service with auth, cursor encoding/decoding, and
 * input validation, returning structured results the Fastify and
 * Vercel handlers can translate directly into HTTP responses.
 */

import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { CallRecord } from "../types/index.js";
import {
  getCallRecord,
  listRecentCalls,
  listCallsByRole,
  listCallsByStatus,
  deleteCallRecord,
} from "../services/dynamo.js";
import { bearerMatches } from "./auth.js";
import { isValidRole, isValidStatus } from "./enumValidation.js";

const log = logger.child({ core: "records" });

export type RecordResult<T> =
  | { ok: true; status: 200 | 204; body: T | null }
  | { ok: false; status: 400 | 401 | 404 | 500; body: { error: string } };

export type ListResult = {
  records: CallRecord[];
  cursor: string | null;
};

/**
 * Bearer-token auth check shared by all records endpoints.
 *
 * Uses `bearerMatches` for a timing-safe comparison — see C-2 in
 * docs/CODE_REVIEW-vercel-hosting-optimization.md.
 */
export function authorizeRecords(
  authHeader: string | undefined,
): { ok: false; status: 401; body: { error: string } } | null {
  if (!env.outboundApiKey) return null;
  if (!bearerMatches(authHeader, env.outboundApiKey)) {
    return { ok: false, status: 401, body: { error: "Unauthorized" } };
  }
  return null;
}

/** Base64url-encode a DynamoDB lastKey for use as a pagination cursor. */
export function encodeCursor(
  lastKey: Record<string, unknown> | undefined,
): string | null {
  if (!lastKey) return null;
  return Buffer.from(JSON.stringify(lastKey)).toString("base64url");
}

/**
 * Decode a base64url cursor back to a DynamoDB lastKey. Returns
 * undefined on missing or malformed input — callers should treat
 * "couldn't decode" the same as "no cursor" (start from the top).
 */
export function decodeCursor(
  cursor: string | undefined,
): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    return undefined;
  }
}

/**
 * Hard cap on any /records list query, regardless of the caller's
 * requested limit. Protects against `?limit=10000000` DoS
 * amplification — a huge Scan on DynamoDB would time out the
 * serverless function and cost us real money. 100 is still more than
 * enough for any dashboard page.
 *
 * Flagged as H-1 in docs/CODE_REVIEW-vercel-hosting-optimization.md.
 */
export const MAX_RECORDS_LIMIT = 100;

/**
 * Parse a numeric limit query param with a positive-integer guard
 * and a hard upper cap. Returns `fallback` for missing, non-numeric,
 * or non-positive input, and clamps to MAX_RECORDS_LIMIT otherwise.
 */
export function parseLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return Math.min(fallback, MAX_RECORDS_LIMIT);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return Math.min(fallback, MAX_RECORDS_LIMIT);
  }
  return Math.min(n, MAX_RECORDS_LIMIT);
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

/**
 * GET /records/by-role/:role
 *
 * The role path segment is runtime-validated against the
 * CoTrackProRole enum (H-2 in the code review) — an unknown role
 * returns 400 instead of silently querying for a nonexistent value
 * and returning an empty list.
 */
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
  if (!isValidRole(role)) {
    return {
      ok: false,
      status: 400,
      body: { error: `Unknown role: ${role}` },
    };
  }
  const limit = parseLimit(query.limit, 50);
  const lastKey = decodeCursor(query.cursor);
  const result = await listCallsByRole(role, {
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

/**
 * GET /records/by-status/:status
 *
 * The status path segment is runtime-validated against the
 * CallStatus enum (H-2 in the code review).
 */
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
  if (!isValidStatus(status)) {
    return {
      ok: false,
      status: 400,
      body: { error: `Unknown status: ${status}` },
    };
  }
  const limit = parseLimit(query.limit, 50);
  const lastKey = decodeCursor(query.cursor);
  const result = await listCallsByStatus(status, {
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
