/**
 * services/stt.ts — Speech-to-Text via ElevenLabs Scribe Realtime WebSocket
 *
 * Receives mulaw 8kHz audio from Twilio, streams it to ElevenLabs'
 * realtime STT endpoint, and emits transcribed text.
 *
 * ALTERNATIVE: You can swap this for Deepgram, AssemblyAI, or Google STT.
 * The interface is the same: audio in → text out via callbacks.
 */

import WebSocket from "ws";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface STTStreamOptions {
  callSid: string;
  /** Called with partial (interim) transcription text */
  onPartial: (text: string) => void;
  /** Called with committed (final) transcription of an utterance */
  onFinal: (text: string) => void;
  /** Called on error */
  onError: (err: Error) => void;
  /** Called with total audio seconds forwarded when the stream closes. Used for cost metrics. */
  onSeconds?: (secs: number) => void;
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1000;

/** Frame types this client understands. Named so the "unrecognized type"
 *  warning can show an operator what we were expecting instead. */
const KNOWN_MESSAGE_TYPES = [
  "session_started",
  "partial_transcript",
  "committed_transcript",
  "error",
] as const;

/**
 * Below this much forwarded audio, a session with no transcripts is
 * unremarkable — a caller who said nothing, or a call that ended during
 * the greeting. Above it, silence is a finding.
 */
const SILENT_SESSION_AUDIO_SECS = 10;

const REALTIME_STT_ENDPOINT =
  "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

/**
 * Build the realtime STT connection URL.
 *
 * The session is configured ENTIRELY by these query parameters. There is
 * no post-connect configuration message — an earlier version sent a
 * `session_config` frame and got back
 * `{"message_type":"input_error","error":"Unexpected message type:
 * session_config"}`, which left the session on its defaults while we
 * streamed µ-law 8kHz into it. That produced no transcripts, no error
 * the caller could see, and a perfectly normal-looking call.
 *
 * `ulaw_8000` is what Twilio's media stream already sends, so frames
 * forward untranscoded. `commit_strategy=vad` makes ElevenLabs segment
 * on silence rather than requiring us to send explicit commits.
 *
 * Split out from connect() so the parameter set is assertable without a
 * live socket.
 *
 * Reference:
 * https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 */
export function buildRealtimeUrl(): string {
  const params = new URLSearchParams({
    model_id: "scribe_v2_realtime",
    // Twilio media streams are µ-law 8kHz. Matching it here is what
    // lets sendAudio() forward the payload verbatim.
    audio_format: "ulaw_8000",
    language_code: "en",
    // "vad" = segment on detected silence. The alternative, "manual",
    // would require us to set `commit: true` on an audio chunk.
    commit_strategy: "vad",
    vad_silence_threshold_secs: "1.0",
  });
  return `${REALTIME_STT_ENDPOINT}?${params.toString()}`;
}

export class STTStream {
  private ws: WebSocket | null = null;
  private readonly callSid: string;
  private readonly onPartial: (text: string) => void;
  private readonly onFinal: (text: string) => void;
  private readonly onError: (err: Error) => void;
  private readonly onSeconds?: (secs: number) => void;
  private secondsForwarded = 0;
  private secondsReported = false;
  private isClosed = false;
  private reconnectAttempts = 0;
  private log;
  /**
   * Diagnostics for the "audio in, nothing out" failure. A call that
   * transcribes nothing used to look exactly like a call where nobody
   * spoke: no error, no log, just silence. These three fields make the
   * difference visible at close.
   */
  private committedCount = 0;
  private partialCount = 0;
  /** Message types we've already warned about, so one unknown frame type
   *  per session doesn't flood a 50-second call. */
  private readonly unknownTypesSeen = new Set<string>();
  /** Guards warnIfSilent so close() and the socket's own close event
   *  don't both report the same silent session. */
  private silentWarned = false;

  constructor(opts: STTStreamOptions) {
    this.callSid = opts.callSid;
    this.onPartial = opts.onPartial;
    this.onFinal = opts.onFinal;
    this.onError = opts.onError;
    this.onSeconds = opts.onSeconds;
    this.log = logger.child({ callSid: opts.callSid, service: "stt" });
  }

  async connect(): Promise<void> {
    const url = buildRealtimeUrl();

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          "xi-api-key": env.elevenLabsApiKey,
        },
      });

      this.ws.on("open", () => {
        this.reconnectAttempts = 0;
        // Nothing to send here. The session is already configured by the
        // query string — see buildRealtimeUrl(). This handler used to
        // post a `session_config` message, which the API answered with
        // `{"message_type":"input_error","error":"Unexpected message
        // type: session_config"}`, leaving the session on its defaults
        // while we streamed µ-law into it.
        this.log.info("STT WS open");
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("error", (err) => {
        this.log.error({ err }, "STT WS error");
        if (!this.isClosed) this.onError(err);
        reject(err);
      });

      this.ws.on("close", (code) => {
        this.log.info({ code }, "STT WS closed");
        this.warnIfSilent();
        // Auto-reconnect on unexpected close (not a deliberate close())
        if (!this.isClosed && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          this.reconnectAttempts++;
          this.log.warn(
            { attempt: this.reconnectAttempts },
            "STT WS dropped — reconnecting",
          );
          setTimeout(() => {
            if (!this.isClosed) this.connect().catch(() => {});
          }, RECONNECT_DELAY_MS * this.reconnectAttempts);
        }
      });
    });
  }

  /**
   * Dispatch one inbound frame from the STT socket.
   *
   * Split out of the `on("message")` handler so it can be driven directly
   * by tests — `new WebSocket()` is constructed inline in connect(), so
   * there's no socket seam, and this is where all the interesting logic
   * lives anyway. Never throws: a malformed frame is logged and dropped,
   * because killing a live call over one bad frame is worse than
   * ignoring it.
   */
  handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      switch (msg.message_type) {
        case "session_started":
          this.log.info({ sessionId: msg.session_id }, "STT session started");
          break;

        case "partial_transcript":
          if (msg.text) {
            this.partialCount++;
            // Partials arriving while commits don't is the single
            // clearest signal that transcription works and the commit
            // strategy is what's broken. Worth its own line.
            this.log.debug(
              { text: msg.text, n: this.partialCount },
              "STT partial transcript",
            );
            this.onPartial(msg.text);
          }
          break;

        case "committed_transcript":
          if (msg.text) {
            this.committedCount++;
            this.log.debug({ text: msg.text }, "STT final transcript");
            this.onFinal(msg.text);
          }
          break;

        case "error":
          this.log.error({ msg }, "STT error message");
          this.onError(new Error(msg.error || "STT error"));
          break;

        // An unrecognized type used to fall through to nothing — no log,
        // no error, no counter. If the realtime protocol renames a field
        // or adds a frame we don't know, that looked identical to
        // receiving nothing at all. Say what arrived.
        default: {
          const type = String(msg.message_type ?? "(absent)");
          if (!this.unknownTypesSeen.has(type)) {
            this.unknownTypesSeen.add(type);
            this.log.warn(
              { messageType: type, known: KNOWN_MESSAGE_TYPES },
              "Unrecognized STT message type — ignoring (logged once per type)",
            );
          }
          this.log.debug({ raw }, "STT raw frame");
          break;
        }
      }
    } catch (err) {
      this.log.warn({ err }, "Failed to parse STT message");
    }
  }

  /**
   * What this session has seen. Exposed so the silent-session behavior
   * is assertable without scraping log output.
   */
  get diagnostics(): {
    committed: number;
    partials: number;
    unknownTypes: string[];
    audioSecs: number;
  } {
    return {
      committed: this.committedCount,
      partials: this.partialCount,
      unknownTypes: [...this.unknownTypesSeen],
      audioSecs: this.secondsForwarded,
    };
  }

  /**
   * Feed raw mulaw audio (base64) from Twilio into the STT stream.
   * Twilio sends media.payload as base64 mulaw 8kHz.
   * Each Twilio frame is 20ms of audio → 0.02 seconds forwarded per call.
   */
  sendAudio(base64Audio: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Each Twilio media frame is 20ms at 8kHz mulaw
    this.secondsForwarded += 0.02;

    // No sample_rate here: the format is fixed at connect time by
    // `audio_format` in the query string, and an unexpected field is
    // exactly what earned an `input_error` from the session_config
    // frame. `commit` is omitted deliberately — commit_strategy=vad
    // means ElevenLabs segments on silence for us.
    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: base64Audio,
      }),
    );
  }

  close(): void {
    this.isClosed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
    // Report total seconds forwarded exactly once for cost tracking
    if (!this.secondsReported && this.onSeconds) {
      this.secondsReported = true;
      this.onSeconds(this.secondsForwarded);
    }
    this.warnIfSilent();
  }

  /**
   * Say so when a session was fed real audio and produced no transcripts.
   *
   * This is the whole "audio in, nothing out" failure, and until now it
   * was indistinguishable in the logs from a caller who never spoke:
   * ElevenLabs bills the seconds either way, the socket closes cleanly
   * either way, and nothing else fires. The partial count separates the
   * two live causes — partials without commits means transcription works
   * and the commit strategy doesn't; zero of both means the audio isn't
   * being transcribed at all.
   *
   * Fires at most once, from whichever of close()/on("close") runs first.
   */
  private warnIfSilent(): void {
    if (this.silentWarned) return;
    if (this.committedCount > 0) return;
    if (this.secondsForwarded < SILENT_SESSION_AUDIO_SECS) return;

    this.silentWarned = true;
    this.log.warn(
      {
        audioSecs: Math.round(this.secondsForwarded),
        partials: this.partialCount,
        unknownMessageTypes: [...this.unknownTypesSeen],
        hint:
          this.partialCount > 0
            ? "partials arrived but nothing committed — suspect the VAD/commit config"
            : "no partials either — suspect the audio format or session config",
      },
      "STT produced NO committed transcripts despite receiving audio",
    );
  }
}
