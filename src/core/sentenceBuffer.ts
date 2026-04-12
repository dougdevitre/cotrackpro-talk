/**
 * core/sentenceBuffer.ts — Sentence-boundary-aware text buffer for
 * piping Claude text deltas into ElevenLabs TTS.
 *
 * The WebSocket call handler in `src/handlers/callHandler.ts`
 * accumulates streamed text deltas from Claude into a sentence
 * buffer. When a complete sentence boundary appears (period,
 * exclamation, or question mark followed by whitespace), the
 * completed sentences are flushed to TTS as one chunk. A fallback
 * flush timer ensures long non-sentence streams don't stall the
 * audio path.
 *
 * Extracted from `callHandler.ts` as part of E-6/A-6 — the full
 * `callHandler.ts` refactor arc. This class is a pure unit that
 * can be tested independently of the WebSocket + Claude + TTS
 * plumbing around it. Before the extraction, the sentence buffer
 * was closure-level state inside `handleCallStream` with a
 * `resetFlushTimer` + `clearFlushTimer` pair and a
 * `sentenceBuffer` local string — untestable in isolation.
 *
 * Contract:
 *
 *   - `push(delta)` appends a text chunk. If the accumulated buffer
 *     now contains at least one sentence boundary, everything up to
 *     and including the last boundary is emitted to the
 *     `onSentence` callback AS A SINGLE FLUSH. The trailing partial
 *     (if any) is retained for the next `push()`. The flush timer
 *     is reset to the idle timeout after every call.
 *
 *   - `flushRemaining()` emits whatever partial text is left in the
 *     buffer (trimmed to non-empty) as a final `onSentence` call,
 *     clears the timer, and empties the buffer. Used from the
 *     caller's `onComplete` path to drain the last sentence.
 *
 *   - `dispose()` clears the idle timer without emitting. Used on
 *     call teardown so a dangling timer doesn't fire after the
 *     session is gone.
 *
 * The idle timer is the safety net for long clauses that span more
 * than `idleTimeoutMs` without a sentence boundary. Without it, a
 * caller who hears a long mid-sentence pause would get confused
 * ("is the app still there?"). Default is 500ms to match the
 * pre-refactor behavior exactly.
 */

/** Matches the whitespace *after* a sentence-ending punctuation. */
const SENTENCE_END = /(?<=[.!?])\s+/;

/** Default fallback flush timeout. Matches the pre-refactor constant. */
const DEFAULT_IDLE_TIMEOUT_MS = 500;

export interface SentenceBufferOptions {
  /** Called with each flushed chunk — a sentence boundary or
   *  the idle-timer drain. Always ends with a trailing space so
   *  the caller can concatenate chunks cleanly. */
  onSentence: (text: string) => void;
  /** Override the idle flush timeout. Tests use this to keep
   *  runs fast without waiting for the real 500ms. */
  idleTimeoutMs?: number;
  /** Timer implementation. Defaults to the global setTimeout /
   *  clearTimeout. Tests inject a mock when they want deterministic
   *  control over fire-and-cancel. */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export class SentenceBuffer {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly onSentence: (text: string) => void;
  private readonly idleTimeoutMs: number;
  private readonly _setTimeout: typeof setTimeout;
  private readonly _clearTimeout: typeof clearTimeout;

  constructor(opts: SentenceBufferOptions) {
    this.onSentence = opts.onSentence;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this._setTimeout = opts.setTimeout ?? setTimeout;
    this._clearTimeout = opts.clearTimeout ?? clearTimeout;
  }

  /** Returns the number of characters currently buffered. Test-only. */
  get length(): number {
    return this.buffer.length;
  }

  /**
   * Append a text chunk from the upstream (Claude) stream. Flushes
   * any complete sentences to the `onSentence` callback, and
   * resets the idle timer for the trailing partial.
   *
   * Safe to call on a disposed buffer — becomes a no-op.
   */
  push(delta: string): void {
    if (this.disposed) return;
    this.buffer += delta;

    const parts = this.buffer.split(SENTENCE_END);
    if (parts.length > 1) {
      // At least one complete sentence. Emit everything up to the
      // last boundary, retain the trailing partial. The pre-refactor
      // code joined with " " and appended " " — we replicate exactly
      // so the TTS side-effect is byte-identical.
      const toSend = parts.slice(0, -1).join(" ") + " ";
      this.onSentence(toSend);
      this.buffer = parts[parts.length - 1]!;
      this.cancelTimer();
    }

    if (this.buffer) this.resetTimer();
  }

  /**
   * Emit whatever partial text remains, then empty the buffer and
   * cancel the idle timer. Called from the upstream stream's
   * `onComplete` handler so the final half-sentence (if any)
   * reaches TTS before the pipeline declares itself done.
   *
   * Trailing-whitespace note: the pre-refactor code emitted
   * `sentenceBuffer + " "` unconditionally when the trimmed buffer
   * was non-empty. We preserve that — any future trimming would be
   * a characterization-test-level behavior change.
   */
  flushRemaining(): void {
    if (this.disposed) return;
    this.cancelTimer();
    if (this.buffer.trim()) {
      this.onSentence(this.buffer + " ");
    }
    this.buffer = "";
  }

  /**
   * Clear all state without emitting anything and without locking
   * the buffer. Used BETWEEN utterances in the caller's processing
   * loop: the previous utterance may have been interrupted by a
   * tool-use path or discarded without flushing, and the next
   * utterance needs a clean slate. Unlike `flushRemaining`, this
   * never calls `onSentence`.
   *
   * Safe to call on a disposed buffer — becomes a no-op.
   */
  reset(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.buffer = "";
  }

  /**
   * Cancel any pending idle timer and lock the buffer so subsequent
   * `push()` / `flushRemaining()` become no-ops. Called from the
   * caller's cleanup path so a timer firing after session teardown
   * can't undefined-deref a closed TTS stream.
   */
  dispose(): void {
    this.cancelTimer();
    this.buffer = "";
    this.disposed = true;
  }

  // ── Internal timer management ────────────────────────────────

  private resetTimer(): void {
    this.cancelTimer();
    this.timer = this._setTimeout(() => {
      if (this.disposed) return;
      if (this.buffer.trim()) {
        // Emit WHAT WE HAVE as a best-effort flush. The idle path
        // preserves the pre-refactor behavior: `buffer + " "` gets
        // sent and the buffer is cleared.
        this.onSentence(this.buffer + " ");
        this.buffer = "";
      }
      this.timer = null;
    }, this.idleTimeoutMs);
  }

  private cancelTimer(): void {
    if (this.timer) {
      this._clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
