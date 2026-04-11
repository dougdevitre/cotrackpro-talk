/**
 * api/records/by-status/[status].ts — Vercel serverless function
 *
 * GET /records/by-status/:status — List calls in a given status, with
 * optional startDate/endDate/limit/cursor query params.
 *
 * Auth: Bearer token (OUTBOUND_API_KEY).
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  authorizeRecords,
  listRecordsByStatus,
} from "../../../src/core/records.js";
import {
  parseQuery,
  requireMethod,
  sendJson,
} from "../../../src/core/httpAdapter.js";

/**
 * Extract :status from the URL. Vercel may serve the public path
 * ("/records/by-status/active") or the rewritten internal path
 * ("/api/records/by-status/active"), so we anchor on "by-status".
 */
function extractStatus(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const path = url.split("?")[0];
  const parts = path.split("/").filter(Boolean);
  const idx = parts.indexOf("by-status");
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

  const status = extractStatus(req.url);
  const query = parseQuery(req);
  const result = await listRecordsByStatus(status, {
    startDate: query.startDate,
    endDate: query.endDate,
    limit: query.limit,
    cursor: query.cursor,
  });
  sendJson(res, result.status, result.body);
}
