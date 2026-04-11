/**
 * api/records/[callSid].ts — Vercel serverless function
 *
 * GET    /records/:callSid — Fetch a single call record.
 * DELETE /records/:callSid — Delete a call record.
 *
 * Dynamic segment is extracted from req.url (Vercel preserves the
 * original path when routing to a [param] file).
 *
 * Auth: Bearer token (OUTBOUND_API_KEY).
 * Rate limits: RECORDS_RATE_LIMIT_PER_MIN / PER_HOUR (audit E-1).
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  authorizeRecords,
  checkRecordsRateLimit,
  deleteRecord,
  getRecord,
  type RecordResult,
} from "../../src/core/records.js";
import {
  sendJson,
  stampRequestId,
} from "../../src/core/httpAdapter.js";

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
 * Extract the :callSid segment from a URL. Vercel may preserve the
 * public path ("/records/CAxxx") or rewrite it to the internal path
 * ("/api/records/CAxxx"), so we anchor on the "records" segment and
 * grab the one that follows.
 */
function extractCallSid(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const path = url.split("?")[0];
  const parts = path.split("/").filter(Boolean);
  const idx = parts.indexOf("records");
  if (idx < 0 || idx + 1 >= parts.length) return undefined;
  return decodeURIComponent(parts[idx + 1]);
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  stampRequestId(req, res);
  // Reject method first so Retry-After on 429 never reaches a PUT etc.
  if (req.method !== "GET" && req.method !== "DELETE") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, DELETE");
    res.end();
    return;
  }

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

  const callSid = extractCallSid(req.url);

  if (req.method === "GET") {
    sendResult(res, await getRecord(callSid));
    return;
  }

  // DELETE (only other allowed method after the method guard).
  sendResult(res, await deleteRecord(callSid));
}
