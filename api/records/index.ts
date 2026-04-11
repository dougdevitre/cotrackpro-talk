/**
 * api/records/index.ts — Vercel serverless function
 *
 * GET /records — List recent call records (paginated).
 * Auth: Bearer token (OUTBOUND_API_KEY).
 */

import type { IncomingMessage, ServerResponse } from "http";
import { authorizeRecords, listRecords } from "../../src/core/records.js";
import {
  parseQuery,
  requireMethod,
  sendJson,
} from "../../src/core/httpAdapter.js";

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

  const query = parseQuery(req);
  const result = await listRecords({
    limit: query.limit,
    cursor: query.cursor,
  });
  sendJson(res, result.status, result.body);
}
