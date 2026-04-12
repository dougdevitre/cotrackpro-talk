/**
 * tests/streamPipeline.test.ts — Unit tests for the extracted
 * `makeSentencePipedCallbacks` function from Pass 2 of the
 * callHandler.ts refactor.
 *
 * These complement the end-to-end characterization tests in
 * tests/callHandler.test.ts by exercising the individual callback
 * transitions directly: lazy TTS creation, sentence-buffer
 * delegation, time-to-first-token logging, onComplete flushing.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSentencePipedCallbacks } from "../src/core/streamPipeline.js";
import { SentenceBuffer } from "../src/core/sentenceBuffer.js";
import type { TtsStreamLike } from "../src/handlers/callHandler.js";

/**
 * Minimal stub matching the TtsStreamLike structural interface.
 * Captures everything the handler would forward.
 */
function makeStubTts(): TtsStreamLike & {
  textSent: string[];
  connected: boolean;
  flushed: boolean;
  closed: boolean;
} {
  const state = {
    textSent: [] as string[],
    connected: false,
    flushed: false,
    closed: false,
  };
  return {
    ...state,
    async connect() {
      this.connected = true;
    },
    sendText(text: string) {
      this.textSent.push(text);
    },
    flush() {
      this.flushed = true;
    },
    close() {
      this.closed = true;
    },
  };
}

/**
 * Build a scenario: a mutable currentTts reference, a factory
 * that increments a counter each time it runs, a minimal
 * SentenceBuffer wired to whatever TTS is current, and a log
 * stub that captures messages.
 */
function buildScenario(opts: {
  /** Initial currentTts — pass a stub to test the non-lazy path,
   *  pass undefined to test the lazy-create fallback. */
  initialTts?: ReturnType<typeof makeStubTts>;
} = {}) {
  let currentTts: TtsStreamLike | undefined = opts.initialTts;
  let createdCount = 0;

  const sentenceBuffer = new SentenceBuffer({
    onSentence: (text) => {
      currentTts?.sendText(text);
    },
    // Override the timer so tests don't wait — fake setTimeout that
    // never actually fires.
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as unknown as typeof clearTimeout,
  });

  const logMessages: Array<{ args: unknown[] }> = [];
  const log = {
    info: (...args: unknown[]) => logMessages.push({ args }),
    error: (...args: unknown[]) => logMessages.push({ args }),
  };

  return {
    sentenceBuffer,
    log,
    logMessages,
    getCurrentTts: () => currentTts,
    setCurrentTts: (tts: TtsStreamLike) => {
      currentTts = tts;
    },
    createTtsStream: async () => {
      createdCount++;
      const fresh = makeStubTts();
      fresh.connected = true;
      return fresh;
    },
    getCreatedCount: () => createdCount,
  };
}

describe("makeSentencePipedCallbacks — happy path", () => {
  it("forwards a single-delta text response through sentence buffer → TTS", async () => {
    const tts = makeStubTts();
    tts.connected = true;
    const s = buildScenario({ initialTts: tts });

    let doneCalled = false;
    const callbacks = makeSentencePipedCallbacks(
      {
        getCurrentTts: s.getCurrentTts,
        setCurrentTts: s.setCurrentTts,
        createTtsStream: s.createTtsStream,
        sentenceBuffer: s.sentenceBuffer,
        log: s.log,
      },
      (fullText) => {
        doneCalled = true;
        assert.equal(fullText, "Hello world.");
      },
      () => {
        assert.fail("onFail should not be called on happy path");
      },
    );

    await callbacks.onTextDelta("Hello world.");
    await callbacks.onComplete("Hello world.");

    // The sentence buffer should have emitted via `flushRemaining`
    // (no boundary + space in "Hello world." since there's no
    // whitespace after the period).
    assert.deepEqual(tts.textSent, ["Hello world. "]);
    assert.equal(tts.flushed, true);
    assert.equal(doneCalled, true);
    // Lazy factory should not have been invoked.
    assert.equal(s.getCreatedCount(), 0);
  });

  it("emits complete sentences before the final flush when they arrive mid-stream", async () => {
    const tts = makeStubTts();
    tts.connected = true;
    const s = buildScenario({ initialTts: tts });

    const callbacks = makeSentencePipedCallbacks(
      {
        getCurrentTts: s.getCurrentTts,
        setCurrentTts: s.setCurrentTts,
        createTtsStream: s.createTtsStream,
        sentenceBuffer: s.sentenceBuffer,
        log: s.log,
      },
      () => {},
      () => {},
    );

    // First delta has a complete sentence mid-stream.
    await callbacks.onTextDelta("Of course. I can help with that.");
    // The SentenceBuffer splits on `/(?<=[.!?])\s+/` — so "Of course. I can help with that."
    // → parts ["Of course.", "I can help with that."] → emit "Of course. "
    // → retain "I can help with that."
    assert.deepEqual(tts.textSent, ["Of course. "]);

    // onComplete drains the retained partial and flushes.
    await callbacks.onComplete("Of course. I can help with that.");
    assert.deepEqual(tts.textSent, ["Of course. ", "I can help with that. "]);
    assert.equal(tts.flushed, true);
  });
});

describe("makeSentencePipedCallbacks — lazy TTS creation fallback", () => {
  it("creates a TTS stream on first delta when currentTts is undefined", async () => {
    const s = buildScenario({ initialTts: undefined });

    const callbacks = makeSentencePipedCallbacks(
      {
        getCurrentTts: s.getCurrentTts,
        setCurrentTts: s.setCurrentTts,
        createTtsStream: s.createTtsStream,
        sentenceBuffer: s.sentenceBuffer,
        log: s.log,
      },
      () => {},
      () => {},
    );

    assert.equal(s.getCurrentTts(), undefined);

    await callbacks.onTextDelta("First word. ");

    // Factory should have been called exactly once.
    assert.equal(s.getCreatedCount(), 1);
    // currentTts should now be set.
    assert.ok(s.getCurrentTts());
  });

  it("does not re-create a TTS stream if one already exists", async () => {
    const tts = makeStubTts();
    tts.connected = true;
    const s = buildScenario({ initialTts: tts });

    const callbacks = makeSentencePipedCallbacks(
      {
        getCurrentTts: s.getCurrentTts,
        setCurrentTts: s.setCurrentTts,
        createTtsStream: s.createTtsStream,
        sentenceBuffer: s.sentenceBuffer,
        log: s.log,
      },
      () => {},
      () => {},
    );

    await callbacks.onTextDelta("Hello. ");
    await callbacks.onComplete("Hello.");

    // Factory should never have been called.
    assert.equal(s.getCreatedCount(), 0);
  });

  it("creates a TTS stream inside onComplete if no deltas arrived", async () => {
    // Edge case: Claude responds with an empty completion. onComplete
    // fires without any preceding onTextDelta, so the lazy path has
    // to catch this too.
    const s = buildScenario({ initialTts: undefined });

    const callbacks = makeSentencePipedCallbacks(
      {
        getCurrentTts: s.getCurrentTts,
        setCurrentTts: s.setCurrentTts,
        createTtsStream: s.createTtsStream,
        sentenceBuffer: s.sentenceBuffer,
        log: s.log,
      },
      () => {},
      () => {},
    );

    await callbacks.onComplete("");
    assert.equal(s.getCreatedCount(), 1);
    assert.ok(s.getCurrentTts());
  });
});

describe("makeSentencePipedCallbacks — logging", () => {
  it("logs time-to-first-text-delta on the first onTextDelta only", async () => {
    const tts = makeStubTts();
    tts.connected = true;
    const s = buildScenario({ initialTts: tts });

    const callbacks = makeSentencePipedCallbacks(
      {
        getCurrentTts: s.getCurrentTts,
        setCurrentTts: s.setCurrentTts,
        createTtsStream: s.createTtsStream,
        sentenceBuffer: s.sentenceBuffer,
        log: s.log,
      },
      () => {},
      () => {},
    );

    await callbacks.onTextDelta("First");
    await callbacks.onTextDelta(" second");
    await callbacks.onTextDelta(" third");

    // Exactly one ttftMs log line — the first delta.
    const ttftLines = s.logMessages.filter((m) =>
      JSON.stringify(m.args).includes("Time to first text delta"),
    );
    assert.equal(ttftLines.length, 1);
  });

  it("logs totalMs on onComplete", async () => {
    const tts = makeStubTts();
    tts.connected = true;
    const s = buildScenario({ initialTts: tts });

    const callbacks = makeSentencePipedCallbacks(
      {
        getCurrentTts: s.getCurrentTts,
        setCurrentTts: s.setCurrentTts,
        createTtsStream: s.createTtsStream,
        sentenceBuffer: s.sentenceBuffer,
        log: s.log,
      },
      () => {},
      () => {},
    );

    await callbacks.onComplete("Hello.");
    const completeLines = s.logMessages.filter((m) =>
      JSON.stringify(m.args).includes("Response complete"),
    );
    assert.equal(completeLines.length, 1);
  });
});

describe("makeSentencePipedCallbacks — onError passthrough", () => {
  it("forwards errors to the onFail callback as-is", async () => {
    const tts = makeStubTts();
    tts.connected = true;
    const s = buildScenario({ initialTts: tts });

    let captured: Error | undefined;
    const callbacks = makeSentencePipedCallbacks(
      {
        getCurrentTts: s.getCurrentTts,
        setCurrentTts: s.setCurrentTts,
        createTtsStream: s.createTtsStream,
        sentenceBuffer: s.sentenceBuffer,
        log: s.log,
      },
      () => assert.fail("onDone should not fire on error"),
      (err) => {
        captured = err;
      },
    );

    const boom = new Error("boom");
    callbacks.onError(boom);
    assert.equal(captured, boom);
  });
});
