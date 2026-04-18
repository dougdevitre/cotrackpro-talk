/**
 * api/ai/tts.ts — Vercel serverless function
 *
 * POST /api/ai/tts — ElevenLabs TTS proxy for CoTrackPro sub-apps.
 *                    Clerk JWT required; per-user rate limits enforced
 *                    via shared KV.
 *
 * Body (JSON): { text: string, voiceId?: string, app?: string }
 * Response:    audio bytes (Content-Type: audio/mpeg) on success,
 *              JSON error body on failure.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { synthesizeTts, type TtsRequest, type TtsResult } from "../../src/core/tts.js";
import { corsHeaders } from "../../src/core/cors.js";
import { parseBody, sendJson, stampRequestId } from "../../src/core/httpAdapter.js";

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const headers = corsHeaders(req.headers.origin as string | undefined);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

function sendResult(res: ServerResponse, result: TtsResult): void {
  if (result.ok) {
    res.statusCode = 200;
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Length", String(result.audio.length));
    res.end(result.audio);
    return;
  }
  if (result.headers) {
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

  const body = (await parseBody(req)) as unknown as TtsRequest | undefined;
  const result = await synthesizeTts(req.headers.authorization, body);
  sendResult(res, result);
}
