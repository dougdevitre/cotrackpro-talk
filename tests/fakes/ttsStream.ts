/**
 * tests/fakes/ttsStream.ts — Test double for the ElevenLabs TTS service.
 *
 * The real `ElevenLabsStream` opens a WebSocket to ElevenLabs, streams
 * text input in, and receives base64 ulaw_8000 audio chunks back. The
 * fake captures text sends and lets the test emit audio frames on
 * demand via `emitAudio` + `emitDone`.
 *
 * Implements `TtsStreamLike` from `src/handlers/callHandler.ts` so
 * `deps.makeTtsStream` can return it directly.
 *
 * Note: `handleCallStream` creates a new TTS stream per utterance
 * (inside `createTtsStream`), so tests that cover multiple utterances
 * need a factory that creates a fresh `FakeTtsStream` each time AND
 * hands them out to the test in the order they're created. See
 * `collectingTtsFactory` at the bottom for a helper.
 */

import type { ElevenLabsStreamOptions } from "../../src/services/elevenlabs.js";
import type { TtsStreamLike } from "../../src/handlers/callHandler.js";

export class FakeTtsStream implements TtsStreamLike {
  /** All text chunks sent via `sendText()`, in order. */
  public readonly textSent: string[] = [];
  /** True after `connect()` resolved. */
  public connected = false;
  /** True after `flush()` was called at least once. */
  public flushed = false;
  /** True after `close()` was called. */
  public closed = false;

  private readonly onAudio: (b64: string) => void;
  private readonly onDone: () => void;
  private readonly onError: (err: Error) => void;
  private readonly onChars?: (chars: number) => void;
  private charsSent = 0;

  constructor(opts: ElevenLabsStreamOptions) {
    this.onAudio = opts.onAudio;
    this.onDone = opts.onDone;
    this.onError = opts.onError;
    this.onChars = opts.onChars;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  sendText(text: string): void {
    this.textSent.push(text);
    this.charsSent += text.length;
  }

  flush(): void {
    this.flushed = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onChars?.(this.charsSent);
  }

  // ── Test-only drive helpers ────────────────────────────────────

  /**
   * Simulate the TTS service emitting an audio frame. The handler
   * forwards it to the Twilio socket.
   */
  emitAudio(base64: string): void {
    this.onAudio(base64);
  }

  /**
   * Simulate the TTS service finishing the current utterance. The
   * handler responds by sending a `mark` event to Twilio.
   */
  emitDone(): void {
    this.onDone();
  }

  /** Simulate a transport error from the TTS service. */
  emitError(err: Error): void {
    this.onError(err);
  }
}

/**
 * Factory helper: returns a `makeTtsStream` function plus a list that
 * collects every fake created by it. Use this when a test spans
 * multiple utterances and needs to drive each TTS stream individually.
 *
 * ```ts
 * const { factory, created } = collectingTtsFactory();
 * const handlerPromise = handleCallStream(socket, { makeTtsStream: factory, ... });
 * // ... after handler creates a stream:
 * const firstTts = created[0];
 * firstTts.emitAudio("base64chunk");
 * ```
 */
export function collectingTtsFactory(): {
  factory: (opts: ElevenLabsStreamOptions) => FakeTtsStream;
  created: FakeTtsStream[];
} {
  const created: FakeTtsStream[] = [];
  return {
    factory: (opts) => {
      const fake = new FakeTtsStream(opts);
      created.push(fake);
      return fake;
    },
    created,
  };
}
