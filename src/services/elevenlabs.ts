/**
 * services/elevenlabs.ts — ElevenLabs TTS WebSocket streaming service
 *
 * Opens a persistent WebSocket to the ElevenLabs TTS input-streaming
 * endpoint. Text chunks from Anthropic are piped in as they arrive;
 * audio chunks (ulaw_8000, base64) are emitted back for Twilio.
 *
 * KEY DESIGN DECISIONS:
 * - Output format: ulaw_8000 — native Twilio mulaw, zero transcoding needed.
 * - Model: eleven_flash_v2_5 — ~75ms TTFB, optimized for telephony latency.
 * - We use the standard (single-context) WebSocket for simplicity.
 *   For barge-in with overlapping contexts, upgrade to multi-context WS.
 */

import WebSocket from "ws";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { ElevenLabsAudioResponse } from "../types/index.js";

export interface ElevenLabsStreamOptions {
  voiceId: string;
  callSid: string;
  /** Called with each base64-encoded ulaw_8000 audio chunk */
  onAudio: (base64Audio: string) => void;
  /** Called when the TTS generation for this utterance is complete */
  onDone: () => void;
  /** Called on error */
  onError: (err: Error) => void;
  /** Called with the total characters sent when the stream closes. Used for cost metrics. */
  onChars?: (chars: number) => void;
}

export class ElevenLabsStream {
  private ws: WebSocket | null = null;
  private readonly voiceId: string;
  private readonly callSid: string;
  private readonly onAudio: (b64: string) => void;
  private readonly onDone: () => void;
  private readonly onError: (err: Error) => void;
  private readonly onChars?: (chars: number) => void;
  private charsSent = 0;
  private charsReported = false;
  private isClosed = false;
  private log;

  constructor(opts: ElevenLabsStreamOptions) {
    this.voiceId = opts.voiceId;
    this.callSid = opts.callSid;
    this.onAudio = opts.onAudio;
    this.onDone = opts.onDone;
    this.onError = opts.onError;
    this.onChars = opts.onChars;
    this.log = logger.child({ callSid: opts.callSid, service: "elevenlabs" });
  }

  /** Open the WebSocket and send the beginning-of-stream (BOS) message */
  async connect(): Promise<void> {
    const model = env.elevenLabsModelId;
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input` +
      `?model_id=${model}` +
      `&output_format=ulaw_8000`;

    this.log.info({ url: url.replace(env.elevenLabsApiKey, "***") }, "Connecting to ElevenLabs WS");

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        this.log.info("ElevenLabs WS open — sending BOS");
        // Beginning-of-stream: configure voice settings + auth
        this.ws!.send(
          JSON.stringify({
            text: " ",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0.0,
              use_speaker_boost: true,
            },
            generation_config: {
              // Start generating after fewer chars for lower latency
              chunk_length_schedule: [50],
            },
            xi_api_key: env.elevenLabsApiKey,
          }),
        );
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg: ElevenLabsAudioResponse = JSON.parse(data.toString());
          if (msg.audio) {
            this.onAudio(msg.audio);
          }
          if (msg.isFinal) {
            this.log.debug("ElevenLabs utterance final");
            this.onDone();
          }
        } catch (err) {
          this.log.warn({ err }, "Failed to parse ElevenLabs message");
        }
      });

      this.ws.on("error", (err) => {
        this.log.error({ err }, "ElevenLabs WS error");
        if (!this.isClosed) this.onError(err);
        reject(err);
      });

      this.ws.on("close", (code, reason) => {
        this.log.info({ code, reason: reason.toString() }, "ElevenLabs WS closed");
        this.isClosed = true;
      });
    });
  }

  /** Stream a text chunk into ElevenLabs for TTS generation */
  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn("Cannot send text — ElevenLabs WS not open");
      return;
    }
    this.charsSent += text.length;
    this.ws.send(
      JSON.stringify({
        text,
        try_trigger_generation: true,
      }),
    );
  }

  /** Flush remaining audio — tell ElevenLabs we're done sending text */
  flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        text: "",
      }),
    );
  }

  /** Close the WebSocket connection */
  close(): void {
    this.isClosed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send EOS then close
      try {
        this.ws.send(JSON.stringify({ text: "" }));
      } catch {
        // ignore
      }
      this.ws.close();
    }
    this.ws = null;
    // Report total chars sent exactly once for cost tracking
    if (!this.charsReported && this.onChars) {
      this.charsReported = true;
      this.onChars(this.charsSent);
    }
  }
}
