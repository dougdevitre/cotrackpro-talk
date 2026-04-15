/**
 * api/ai/complete.ts — Vercel serverless function
 *
 * POST /api/ai/complete — Anthropic completion proxy for CoTrackPro
 *                         sub-apps. Clerk JWT required; per-user rate
 *                         limits enforced via shared KV.
 *
 * Body (JSON): {
 *   messages: [{ role: "user"|"assistant", content: string }, ...],
 *   system?: string,
 *   model?: string,
 *   max_tokens?: number,
 *   temperature?: number (0..1),
 *   app?: string   // sub-app identifier for logging
 * }
 */

import type { IncomingMessage, ServerResponse } from "http";
import { completeAi, type AiCompleteRequest, type AiCompleteResult } from "../../src/core/ai.js";
import { corsHeaders } from "../../src/core/cors.js";
import { parseBody, sendJson, stampRequestId } from "../../src/core/httpAdapter.js";

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const headers = corsHeaders(req.headers.origin as string | undefined);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

function sendResult(res: ServerResponse, result: AiCompleteResult): void {
  if (!result.ok && result.headers) {
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  }
  sendJson(res, result.status, result.body);
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  stampRequestId(req, res);
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST, OPTIONS");
    res.end();
    return;
  }

  const body = (await parseBody(req)) as unknown as AiCompleteRequest | undefined;
  const result = await completeAi(req.headers.authorization, body);
  sendResult(res, result);
}
