/**
 * tests/fakes/sttStream.ts — Test double for the STT service.
 *
 * The real `STTStream` opens a WebSocket to ElevenLabs Scribe Realtime
 * and surfaces transcripts via callbacks. The fake captures the same
 * callback contract (`STTStreamOptions`) but lets the test drive the
 * transcript output directly via `emitPartial` / `emitFinal`.
 *
 * Implements `SttStreamLike` from `src/handlers/callHandler.ts` so it
 * can be returned by `deps.makeSttStream` without any `as` casts.
 */

import type { STTStreamOptions } from "../../src/services/stt.js";
import type { SttStreamLike } from "../../src/handlers/callHandler.js";

export class FakeSttStream implements SttStreamLike {
  /** Every `sendAudio` call captured here for tests that care. */
  public readonly audioChunks: string[] = [];
  public connected = false;
  public closed = false;

  private readonly onPartial: (text: string) => void;
  private readonly onFinal: (text: string) => void;
  private readonly onError: (err: Error) => void;
  private readonly onSeconds?: (secs: number) => void;

  constructor(opts: STTStreamOptions) {
    this.onPartial = opts.onPartial;
    this.onFinal = opts.onFinal;
    this.onError = opts.onError;
    this.onSeconds = opts.onSeconds;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  sendAudio(base64Audio: string): void {
    this.audioChunks.push(base64Audio);
  }

  close(): void {
    this.closed = true;
    // Match the real STTStream contract: emit total seconds forwarded
    // when closed, for cost-metric accumulation. Default to 0.
    this.onSeconds?.(0);
  }

  // ── Test-only drive helpers ────────────────────────────────────

  /** Simulate a partial (interim) transcript. */
  emitPartial(text: string): void {
    this.onPartial(text);
  }

  /**
   * Simulate a final (committed) transcript. This is what triggers
   * the call handler's `processUserUtterance` path, so it's the
   * primary way tests drive Claude invocations.
   */
  emitFinal(text: string): void {
    this.onFinal(text);
  }

  /** Simulate a transport error from the STT service. */
  emitError(err: Error): void {
    this.onError(err);
  }

  /** Override the auto-0 onSeconds at close with a specific value. */
  simulateSeconds(secs: number): void {
    this.onSeconds?.(secs);
  }
}
