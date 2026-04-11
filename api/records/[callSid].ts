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
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  authorizeRecords,
  deleteRecord,
  getRecord,
} from "../../src/core/records.js";
import {
  requireMethod,
  sendJson,
  sendStatus,
} from "../../src/core/httpAdapter.js";

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
  const authError = authorizeRecords(req.headers.authorization);
  if (authError) {
    sendJson(res, authError.status, authError.body);
    return;
  }

  const callSid = extractCallSid(req.url);

  if (req.method === "GET") {
    const result = await getRecord(callSid);
    if (result.ok) {
      sendJson(res, result.status, result.body);
    } else {
      sendJson(res, result.status, result.body);
    }
    return;
  }

  if (req.method === "DELETE") {
    const result = await deleteRecord(callSid);
    if (result.ok && result.status === 204) {
      sendStatus(res, 204);
    } else {
      sendJson(res, result.status, result.body);
    }
    return;
  }

  if (!requireMethod(req, res, "GET")) return;
}
