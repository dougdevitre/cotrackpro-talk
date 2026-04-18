/**
 * core/tts.ts — Framework-agnostic TTS proxy for sub-apps.
 *
 * Sub-apps used to synthesize speech client-side via the Google
 * Gemini TTS endpoint, which required the API key to be inlined into
 * the Vite bundle. This proxies ElevenLabs through our own server so
 * the key stays server-side and all TTS spend is auditable per-user.
 *
 * The sibling services/elevenlabs.ts is a WebSocket streaming client
 * used by the telephony pipeline (ulaw_8000 for Twilio). Browser
 * clients don't do ulaw — they want a one-shot mp3 they can drop into
 * an Audio element, so this module uses the REST endpoint instead.
 *
 * Auth: Clerk JWT required. Shares the AI proxy's authorize helper
 * so a single compromised sub-app can't amplify abuse across the two
 * surfaces.
 */

import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { authorizeAi } from "./ai.js";
import { checkRateLimit, hashClientKey } from "./rateLimit.js";

const log = logger.child({ core: "tts" });

export interface TtsRequest {
  text?: unknown;
  voiceId?: unknown;
  app?: unknown;
}

export type TtsResult =
  | {
      ok: true;
      status: 200;
      contentType: string;
      audio: Buffer;
    }
  | {
      ok: false;
      status: 400 | 401 | 413 | 429 | 500 | 502;
      body: { error: string; details?: string; retryAfterSeconds?: number };
      headers?: Record<string, string>;
    };

// Allow-list of output formats so a compromised client can't coerce
// the proxy into requesting exotic ElevenLabs formats that cost more
// or that our callers can't play.
const ALLOWED_OUTPUT_FORMATS = new Set([
  "mp3_22050_32",
  "mp3_44100_32",
  "mp3_44100_64",
  "mp3_44100_96",
  "mp3_44100_128",
  "mp3_44100_192",
]);

// Very light voice_id sanity check. ElevenLabs voice IDs are 20-char
// alphanumeric strings; rejecting anything else prevents header
// injection or URL smuggling via the path segment.
const VOICE_ID_RE = /^[A-Za-z0-9]{16,32}$/;

function contentTypeForFormat(fmt: string): string {
  if (fmt.startsWith("mp3_")) return "audio/mpeg";
  return "application/octet-stream";
}

export async function checkTtsRateLimit(userId: string): Promise<TtsResult | null> {
  const clientKey = hashClientKey(userId);
  const result = await checkRateLimit(clientKey, "tts", {
    perMinute: env.ttsRateLimitPerMin,
    perHour: env.ttsRateLimitPerHour,
  });
  if (result.allowed) return null;

  const retryAfterSeconds = result.resetAt
    ? Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
    : 60;

  log.warn(
    { userId, limitedBy: result.limitedBy, counts: result.counts },
    "TTS proxy rate-limited",
  );

  return {
    ok: false,
    status: 429,
    body: {
      error: "Too many requests",
      details: `Rate limit exceeded (${result.limitedBy} window)`,
      retryAfterSeconds,
    },
    headers: { "Retry-After": String(retryAfterSeconds) },
  };
}

/**
 * Exported for direct unit testing. The end-to-end path goes through
 * `synthesizeTts` which wraps this with auth and rate-limit checks,
 * but those depend on Clerk's verifier and are covered by integration
 * tests rather than unit tests here.
 */
export function validateTtsRequest(body: TtsRequest | undefined): {
  ok: true;
  text: string;
  voiceId: string;
  outputFormat: string;
  app?: string;
} | { ok: false; error: TtsResult } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: {
        ok: false,
        status: 400,
        body: { error: "Invalid body", details: "Expected JSON object" },
      },
    };
  }

  const rawText = body.text;
  if (typeof rawText !== "string" || rawText.length === 0) {
    return {
      ok: false,
      error: {
        ok: false,
        status: 400,
        body: { error: "text required", details: "Non-empty string" },
      },
    };
  }
  if (rawText.length > env.ttsMaxCharsPerRequest) {
    return {
      ok: false,
      error: {
        ok: false,
        status: 413,
        body: {
          error: "text too long",
          details: `Max ${env.ttsMaxCharsPerRequest} chars per request`,
        },
      },
    };
  }

  let voiceId = env.elevenLabsTtsVoiceId;
  if (typeof body.voiceId === "string" && body.voiceId.length > 0) {
    if (!VOICE_ID_RE.test(body.voiceId)) {
      return {
        ok: false,
        error: {
          ok: false,
          status: 400,
          body: { error: "invalid voiceId" },
        },
      };
    }
    voiceId = body.voiceId;
  }

  const outputFormat = env.elevenLabsTtsOutputFormat;
  if (!ALLOWED_OUTPUT_FORMATS.has(outputFormat)) {
    return {
      ok: false,
      error: {
        ok: false,
        status: 500,
        body: {
          error: "TTS misconfigured",
          details: `ELEVENLABS_TTS_OUTPUT_FORMAT=${outputFormat} is not in allow-list`,
        },
      },
    };
  }

  const app = typeof body.app === "string" ? body.app.slice(0, 64) : undefined;

  return { ok: true, text: rawText, voiceId, outputFormat, app };
}

/**
 * ElevenLabs REST fetch. Split out so tests can stub `globalThis.fetch`
 * without mocking the whole module.
 */
async function callElevenLabs(
  text: string,
  voiceId: string,
  outputFormat: string,
): Promise<{ ok: true; audio: Buffer } | { ok: false; status: number; body: string }> {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}` +
    `?output_format=${encodeURIComponent(outputFormat)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": env.elevenLabsApiKey,
      "Content-Type": "application/json",
      Accept: contentTypeForFormat(outputFormat),
    },
    body: JSON.stringify({
      text,
      model_id: env.elevenLabsModelId,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, body };
  }

  const arrayBuffer = await res.arrayBuffer();
  return { ok: true, audio: Buffer.from(arrayBuffer) };
}

export async function synthesizeTts(
  authHeader: string | undefined,
  body: TtsRequest | undefined,
): Promise<TtsResult> {
  const { userId, error: authError } = await authorizeAi(authHeader);
  if (authError) {
    // authorizeAi's error shape is the AI-proxy result union; its
    // error branches (401 Unauthorized, 500 misconfigured) are both
    // valid TtsResult statuses. Re-wrap without pulling in the
    // 200-ok shape that carries AI-specific fields.
    if (authError.ok === false) {
      return {
        ok: false,
        status: authError.status,
        body: authError.body,
        headers: authError.headers,
      };
    }
  }

  const rate = await checkTtsRateLimit(userId!);
  if (rate) return rate;

  const v = validateTtsRequest(body);
  if (!v.ok) return v.error;

  try {
    const result = await callElevenLabs(v.text, v.voiceId, v.outputFormat);
    if (!result.ok) {
      log.error(
        { userId, app: v.app, upstreamStatus: result.status, body: result.body.slice(0, 500) },
        "tts.elevenlabs.error",
      );
      if (result.status === 429) {
        return {
          ok: false,
          status: 429,
          body: {
            error: "Upstream rate limit",
            details: "ElevenLabs 429",
            retryAfterSeconds: 30,
          },
          headers: { "Retry-After": "30" },
        };
      }
      return {
        ok: false,
        status: 502,
        body: { error: "Upstream error", details: `ElevenLabs ${result.status}` },
      };
    }

    log.info(
      { userId, app: v.app, chars: v.text.length, voiceId: v.voiceId, bytes: result.audio.length },
      "tts.synthesize",
    );

    return {
      ok: true,
      status: 200,
      contentType: contentTypeForFormat(v.outputFormat),
      audio: result.audio,
    };
  } catch (err) {
    const e = err as { message?: string };
    log.error({ err, userId, app: v.app }, "tts.error");
    return {
      ok: false,
      status: 502,
      body: { error: "Upstream error", details: e.message ?? "ElevenLabs call failed" },
    };
  }
}
