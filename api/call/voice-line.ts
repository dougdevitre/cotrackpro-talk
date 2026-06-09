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
  loadVoiceLineAudio,
  storeVoiceLineAudio,
  verifyVoiceLineToken,
  VOICE_LINE_OUTPUT_FORMAT,
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

  // Serve a previously-rendered render if we have one: Twilio retries the
  // media fetch on transient errors, and the token stays valid for the
  // whole TTL — re-rendering each fetch would re-bill ElevenLabs.
  const cached = await loadVoiceLineAudio(id);
  if (cached) {
    const buf = Buffer.from(cached.audioB64, "base64");
    res.statusCode = 200;
    res.setHeader("Content-Type", cached.contentType);
    res.setHeader("Content-Length", String(buf.length));
    res.end(buf);
    return;
  }

  const pending = await loadVoiceLine(id);
  if (!pending) {
    log.warn({ id }, "voice-line token has no pending render (expired?)");
    sendStatus(res, 404, "Not found");
    return;
  }

  // Pin the telephony mp3 format so a browser-TTS env change can't turn
  // the call into dead air (see VOICE_LINE_OUTPUT_FORMAT).
  const render = await renderTtsAudio(pending.line, pending.voiceId, VOICE_LINE_OUTPUT_FORMAT);
  if (!render.ok) {
    log.error({ id, upstreamStatus: render.status }, "voice-line render failed");
    // 502 so Twilio surfaces a playback error rather than a hung call.
    sendStatus(res, 502, "Render failed");
    return;
  }

  await storeVoiceLineAudio(id, {
    contentType: render.contentType,
    audioB64: render.audio.toString("base64"),
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", render.contentType);
  res.setHeader("Content-Length", String(render.audio.length));
  res.end(render.audio);
}
