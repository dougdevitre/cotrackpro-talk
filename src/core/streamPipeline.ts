/**
 * core/streamPipeline.ts — Sentence-piped Claude→TTS stream
 * callbacks.
 *
 * Given:
 *   - a SentenceBuffer (from src/core/sentenceBuffer.ts)
 *   - a way to read + create the current TTS stream
 *   - a caller-supplied `onDone` / `onFail`
 *
 * …produces a `StreamCallbacks` object compatible with the Anthropic
 * SDK's `client.messages.stream(...)` callback shape, with the
 * sentence-buffering, TTS lazy-creation, and time-to-first-token
 * logging already wired in.
 *
 * Extracted from `handleCallStream` in `src/handlers/callHandler.ts`
 * as Pass 2 of the E-6/A-6 refactor arc. The previous version was a
 * closure that read + wrote four different handler-scoped locals
 * (`currentTts`, `sentenceBuffer`, `firstDeltaReceived`, `startMs`)
 * which made it impossible to unit test in isolation. The new
 * version takes those as explicit parameters via a narrow
 * `StreamPipelineContext` so it can be exercised directly.
 *
 * Kept behaviorally equivalent to the pre-refactor closure:
 *
 *   1. On first `onTextDelta`, log a `ttftMs` info line with the
 *      time from `makeSentencePipedCallbacks` call to first delta.
 *   2. If `getCurrentTts()` returns undefined when a delta arrives,
 *      lazy-create one via `createTtsStream()` and register it via
 *      `setCurrentTts`. In the current call flow this branch never
 *      fires (the greeting always sets currentTts first), but it's
 *      a defensive fallback against future code paths.
 *   3. Forward each delta to `sentenceBuffer.push(delta)`. The
 *      buffer owns boundary detection + idle-flush timer + the
 *      TTS sendText side-effect.
 *   4. On `onComplete`, lazy-create TTS if missing, drain the
 *      buffer via `flushRemaining()`, flush the TTS stream, and
 *      invoke `onDone(fullText)`.
 *   5. Forward `onError` through as-is.
 *
 * The characterization tests in tests/callHandler.test.ts still
 * validate this at the end-to-end level; this file's unit tests
 * in tests/streamPipeline.test.ts target the individual
 * transitions directly so future refactors catch regressions at
 * the unit level before the characterization tests do.
 */

import type { StreamCallbacks } from "../services/anthropic.js";
import type { TtsStreamLike } from "../handlers/callHandler.js";
import type { SentenceBuffer } from "./sentenceBuffer.js";

export interface StreamPipelineContext {
  /**
   * Getter for the currently-active TTS stream, if any. Used by
   * the lazy-creation check inside `onTextDelta` / `onComplete`.
   * Passing this as a getter (not a value) is intentional:
   * `currentTts` is a moving reference in the handler scope, and
   * we want the callback to see the latest value on every fire.
   */
  getCurrentTts: () => TtsStreamLike | undefined;

  /**
   * Called with a freshly-created TTS stream when the lazy path
   * fires. The handler uses this to update its `currentTts` local
   * so the SentenceBuffer's `onSentence` callback (which also
   * reads `currentTts`) sees the new stream.
   */
  setCurrentTts: (tts: TtsStreamLike) => void;

  /**
   * Factory for a new TTS stream. Invoked on the lazy path only.
   * The handler supplies its own closure over the call-scoped
   * ElevenLabs voice ID, cost-metrics accumulation, etc.
   */
  createTtsStream: () => Promise<TtsStreamLike>;

  /**
   * Sentence buffer that owns boundary detection + the idle
   * flush timer. `push` / `flushRemaining` are driven by the
   * callbacks; the handler's SentenceBuffer instance is shared
   * across utterances so its `onSentence` callback reads the
   * current TTS stream reliably.
   */
  sentenceBuffer: SentenceBuffer;

  /**
   * Narrow logger interface — just the two methods used by the
   * callback. Accepting an interface rather than a pino Logger
   * keeps this file free of a pino dependency.
   */
  log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * Build a StreamCallbacks object for a single Claude streaming
 * call (`streamResponse` or `sendToolResult`). Called once per
 * utterance.
 *
 * @param ctx    Static context (buffer, getter/setter, factory, log)
 * @param onDone Caller callback when the stream completes
 *               successfully. Passed the full concatenated text.
 * @param onFail Caller callback when the stream errors. Wired
 *               directly through to `StreamCallbacks.onError`.
 */
export function makeSentencePipedCallbacks(
  ctx: StreamPipelineContext,
  onDone: (fullText: string) => void,
  onFail: (err: Error) => void,
): StreamCallbacks {
  let firstDeltaReceived = false;
  const startMs = Date.now();

  return {
    onTextDelta: async (delta) => {
      // Lazy TTS creation. See the callHandler.ts comment for why
      // this branch is unreachable in the current flow but still
      // worth having as a defensive fallback.
      if (!ctx.getCurrentTts()) {
        const tts = await ctx.createTtsStream();
        ctx.setCurrentTts(tts);
      }

      if (!firstDeltaReceived) {
        firstDeltaReceived = true;
        ctx.log.info(
          { ttftMs: Date.now() - startMs },
          "Time to first text delta",
        );
      }

      // Let the SentenceBuffer own boundary detection + partial
      // retention + the idle-flush timer.
      ctx.sentenceBuffer.push(delta);
    },

    onComplete: async (fullText) => {
      // Same defensive-lazy pattern as onTextDelta — never fires in
      // practice, but would save a crash if a caller streamed zero
      // deltas and went straight to onComplete on an empty
      // current-TTS state.
      if (!ctx.getCurrentTts()) {
        const tts = await ctx.createTtsStream();
        ctx.setCurrentTts(tts);
      }

      // Drain any trailing partial then flush the TTS stream so
      // ElevenLabs finishes generating.
      ctx.sentenceBuffer.flushRemaining();
      ctx.getCurrentTts()?.flush();

      ctx.log.info(
        { totalMs: Date.now() - startMs },
        "Response complete",
      );
      onDone(fullText);
    },

    onError: onFail,
  };
}
