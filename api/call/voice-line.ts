/**
 * api/call/voice-line.ts — Vercel serverless function
 *
 * GET /call/voice-line?id=<signed-token>
 *
 * Twilio fetches this URL (referenced from the <Play> in the TwiML that
 * api/call/outbound.ts hands to calls.create). We verify the HMAC-signed
 * token, look up the pending { voiceId, line } the outbound handler
 * stashed in KV, render it through ElevenLabs, and stream the audio
 * back as audio/mpeg for Twilio to play.
 *
 * The token is signed so a leaked/guessed URL can't coerce arbitrary
 * renders (ElevenLabs is billed per char). Unknown/expired/forged tokens
 * get a 404.
 *
 * PII: the spoken line is never logged.
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  loadVoiceLine,
  verifyVoiceLineToken,
} from "../../src/core/voiceOutbound.js";
import { renderTtsAudio } from "../../src/core/tts.js";
import { logger } from "../../src/utils/logger.js";
import {
  parseQuery,
  requireMethod,
  sendStatus,
  stampRequestId,
} from "../../src/core/httpAdapter.js";

const log = logger.child({ api: "voice-line" });

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  stampRequestId(req, res);
  if (!requireMethod(req, res, "GET")) return;

  const id = verifyVoiceLineToken(parseQuery(req).id);
  if (!id) {
    sendStatus(res, 404, "Not found");
    return;
  }

  const pending = await loadVoiceLine(id);
  if (!pending) {
    log.warn({ id }, "voice-line token has no pending render (expired?)");
    sendStatus(res, 404, "Not found");
    return;
  }

  const render = await renderTtsAudio(pending.line, pending.voiceId);
  if (!render.ok) {
    log.error({ id, upstreamStatus: render.status }, "voice-line render failed");
    // 502 so Twilio surfaces a playback error rather than a hung call.
    sendStatus(res, 502, "Render failed");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", render.contentType);
  res.setHeader("Content-Length", String(render.audio.length));
  res.end(render.audio);
}
