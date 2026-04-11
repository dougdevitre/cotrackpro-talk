/**
 * api/records/by-role/[role].ts — Vercel serverless function
 *
 * GET /records/by-role/:role — List calls for a given role, with
 * optional startDate/endDate/limit/cursor query params.
 *
 * Auth: Bearer token (OUTBOUND_API_KEY).
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  authorizeRecords,
  listRecordsByRole,
} from "../../../src/core/records.js";
import {
  parseQuery,
  requireMethod,
  sendJson,
} from "../../../src/core/httpAdapter.js";

/**
 * Extract :role from the URL. Vercel may serve the public path
 * ("/records/by-role/parent") or the rewritten internal path
 * ("/api/records/by-role/parent"), so we anchor on "by-role".
 */
function extractRole(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const path = url.split("?")[0];
  const parts = path.split("/").filter(Boolean);
  const idx = parts.indexOf("by-role");
  if (idx < 0 || idx + 1 >= parts.length) return undefined;
  return decodeURIComponent(parts[idx + 1]);
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!requireMethod(req, res, "GET")) return;

  const authError = authorizeRecords(req.headers.authorization);
  if (authError) {
    sendJson(res, authError.status, authError.body);
    return;
  }

  const role = extractRole(req.url);
  const query = parseQuery(req);
  const result = await listRecordsByRole(role, {
    startDate: query.startDate,
    endDate: query.endDate,
    limit: query.limit,
    cursor: query.cursor,
  });
  sendJson(res, result.status, result.body);
}
