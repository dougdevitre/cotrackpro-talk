/**
 * api/records/index.ts — Vercel serverless function
 *
 * GET /records — List recent call records (paginated).
 * Auth: Bearer token (OUTBOUND_API_KEY).
 * Rate limits: RECORDS_RATE_LIMIT_PER_MIN / PER_HOUR (audit E-1).
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  authorizeRecords,
  checkRecordsRateLimit,
  listRecords,
  type RecordResult,
} from "../../src/core/records.js";
import {
  parseQuery,
  requireMethod,
  sendJson,
  stampRequestId,
} from "../../src/core/httpAdapter.js";

/**
 * Send a RecordResult through a Vercel ServerResponse, handling the
 * 429 Retry-After header and the 204 no-body path correctly. Kept in
 * the adapter layer because each Vercel handler lives in its own
 * file — sharing this as a local helper keeps them consistent.
 */
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

  const query = parseQuery(req);
  const result = await listRecords({
    limit: query.limit,
    cursor: query.cursor,
  });
  sendResult(res, result);
}
