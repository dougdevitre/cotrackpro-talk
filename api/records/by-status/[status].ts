/**
 * api/records/by-status/[status].ts — Vercel serverless function
 *
 * GET /records/by-status/:status — List calls in a given status, with
 * optional startDate/endDate/limit/cursor query params.
 *
 * Auth: Bearer token (OUTBOUND_API_KEY).
 * Rate limits: RECORDS_RATE_LIMIT_PER_MIN / PER_HOUR (audit E-1).
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  authorizeRecords,
  checkRecordsRateLimit,
  listRecordsByStatus,
  type RecordResult,
} from "../../../src/core/records.js";
import {
  parseQuery,
  requireMethod,
  sendJson,
  stampRequestId,
} from "../../../src/core/httpAdapter.js";

function sendResult<T>(res: ServerResponse, result: RecordResult<T>): void {
  if (!result.ok && result.headers) {
    for (const [k, v] of Object.entries(result.headers)) {
      res.setHeader(k, v);
    }
  }
  if (result.status === 204) {
    res.statusCode = 204;
    res.end();
    return;
  }
  sendJson(res, result.status, result.body);
}

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
  stampRequestId(req, res);
  if (!requireMethod(req, res, "GET")) return;

  const authError = authorizeRecords(req.headers.authorization);
  if (authError) {
    sendResult(res, authError);
    return;
  }

  const rateLimitError = await checkRecordsRateLimit<unknown>(
    req.headers.authorization,
  );
  if (rateLimitError) {
    sendResult(res, rateLimitError);
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
  sendResult(res, result);
}
