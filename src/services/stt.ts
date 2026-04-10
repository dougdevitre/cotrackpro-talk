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
}

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1000;

export class STTStream {
  private ws: WebSocket | null = null;
  private readonly callSid: string;
  private readonly onPartial: (text: string) => void;
  private readonly onFinal: (text: string) => void;
  private readonly onError: (err: Error) => void;
  private isClosed = false;
  private reconnectAttempts = 0;
  private log;

  constructor(opts: STTStreamOptions) {
    this.callSid = opts.callSid;
    this.onPartial = opts.onPartial;
    this.onFinal = opts.onFinal;
    this.onError = opts.onError;
    this.log = logger.child({ callSid: opts.callSid, service: "stt" });
  }

  async connect(): Promise<void> {
    const url = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          "xi-api-key": env.elevenLabsApiKey,
        },
      });

      this.ws.on("open", () => {
        this.reconnectAttempts = 0;
        this.log.info("STT WS open — configuring session");
        // Configure the STT session for mulaw 8kHz (Twilio format)
        this.ws!.send(
          JSON.stringify({
            message_type: "session_config",
            audio_format: "ulaw_8000",
            sample_rate: 8000,
            language_code: "en",
            model_id: "scribe_v2_realtime",
            // VAD-based auto-commit: detects when the user stops speaking
            vad_commit_strategy: true,
            vad_silence_threshold_secs: 1.0,
          }),
        );
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());

          switch (msg.message_type) {
            case "session_started":
              this.log.info({ sessionId: msg.session_id }, "STT session started");
              break;

            case "partial_transcript":
              if (msg.text) {
                this.onPartial(msg.text);
              }
              break;

            case "committed_transcript":
              if (msg.text) {
                this.log.debug({ text: msg.text }, "STT final transcript");
                this.onFinal(msg.text);
              }
              break;

            case "error":
              this.log.error({ msg }, "STT error message");
              this.onError(new Error(msg.error || "STT error"));
              break;
          }
        } catch (err) {
          this.log.warn({ err }, "Failed to parse STT message");
        }
      });

      this.ws.on("error", (err) => {
        this.log.error({ err }, "STT WS error");
        if (!this.isClosed) this.onError(err);
        reject(err);
      });

      this.ws.on("close", (code) => {
        this.log.info({ code }, "STT WS closed");
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
   * Feed raw mulaw audio (base64) from Twilio into the STT stream.
   * Twilio sends media.payload as base64 mulaw 8kHz.
   */
  sendAudio(base64Audio: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: base64Audio,
        sample_rate: 8000,
      }),
    );
  }

  close(): void {
    this.isClosed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }
}
