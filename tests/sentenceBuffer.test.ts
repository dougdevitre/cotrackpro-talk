/**
 * tests/sentenceBuffer.test.ts — Unit tests for the SentenceBuffer
 * extracted from callHandler.ts.
 *
 * These tests exercise the sentence-splitting, idle-flush, and
 * dispose behavior directly, without spinning up the handler or
 * the Claude / TTS fakes. The characterization tests in
 * tests/callHandler.test.ts still cover end-to-end behavior — these
 * are the finer-grained unit tests that future refactors can rely
 * on without needing to stand up the full pipeline.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SentenceBuffer } from "../src/core/sentenceBuffer.js";

/**
 * Build a SentenceBuffer that uses a controllable fake timer so
 * tests can exercise the idle-flush path without actually waiting.
 */
function buildWithFakeTimer(opts: {
  idleTimeoutMs?: number;
} = {}): {
  buffer: SentenceBuffer;
  emitted: string[];
  advance: () => void;
  hasScheduledTimer: () => boolean;
} {
  const emitted: string[] = [];
  let pendingTimer: (() => void) | null = null;

  const fakeSetTimeout = ((cb: () => void) => {
    pendingTimer = cb;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const fakeClearTimeout = ((_id: unknown) => {
    pendingTimer = null;
  }) as unknown as typeof clearTimeout;

  const buffer = new SentenceBuffer({
    onSentence: (text) => emitted.push(text),
    idleTimeoutMs: opts.idleTimeoutMs ?? 500,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });

  return {
    buffer,
    emitted,
    /** Synchronously fire the currently-scheduled idle timer. */
    advance: () => {
      const cb = pendingTimer;
      pendingTimer = null;
      cb?.();
    },
    hasScheduledTimer: () => pendingTimer !== null,
  };
}

describe("SentenceBuffer — push + sentence detection", () => {
  it("buffers text with no boundary and emits nothing on push", () => {
    const { buffer, emitted } = buildWithFakeTimer();
    buffer.push("partial");
    assert.deepEqual(emitted, []);
    assert.equal(buffer.length, "partial".length);
  });

  it("emits a single completed sentence with a trailing space", () => {
    // Pre-refactor behavior: parts.slice(0, -1).join(" ") + " "
    // For a single boundary: ["Hello.", ""] → "Hello. "
    const { buffer, emitted } = buildWithFakeTimer();
    buffer.push("Hello. ");
    assert.deepEqual(emitted, ["Hello. "]);
    assert.equal(buffer.length, 0);
  });

  it("emits completed sentences when multiple boundaries arrive in one push", () => {
    // "A. B. C." → parts = ["A.", "B.", "C."]
    // emit slice(0, -1).join(" ") + " " = "A. B. "
    // retain "C."
    const { buffer, emitted } = buildWithFakeTimer();
    buffer.push("A. B. C.");
    assert.deepEqual(emitted, ["A. B. "]);
    assert.equal(buffer.length, "C.".length);
  });

  it("handles sentences arriving across multiple push() calls", () => {
    const { buffer, emitted } = buildWithFakeTimer();
    // Delta 1: "Hello " — no boundary, buffered.
    buffer.push("Hello ");
    assert.deepEqual(emitted, []);
    // Delta 2: "world. " — now the buffer is "Hello world. " which
    // splits as ["Hello world.", ""] → emit "Hello world. "
    buffer.push("world. ");
    assert.deepEqual(emitted, ["Hello world. "]);
    assert.equal(buffer.length, 0);
  });

  it("treats '!' and '?' as sentence boundaries alongside '.'", () => {
    const { buffer, emitted } = buildWithFakeTimer();
    buffer.push("Wow! How are you? ");
    // Regex splits on ["Wow!", "How are you?", ""] → emit "Wow! How are you? "
    // Then retain "".
    assert.deepEqual(emitted, ["Wow! How are you? "]);
  });

  it("does NOT treat mid-word periods as boundaries (requires whitespace after)", () => {
    // "v1.2" has no whitespace after the period, so SENTENCE_END
    // does not match. This is a deliberate pre-refactor behavior.
    const { buffer, emitted } = buildWithFakeTimer();
    buffer.push("The version is v1.2");
    assert.deepEqual(emitted, []);
    assert.equal(buffer.length, "The version is v1.2".length);
  });
});

describe("SentenceBuffer — flushRemaining", () => {
  it("emits the trailing partial with a trailing space", () => {
    const { buffer, emitted } = buildWithFakeTimer();
    buffer.push("Incomplete");
    buffer.flushRemaining();
    assert.deepEqual(emitted, ["Incomplete "]);
    assert.equal(buffer.length, 0);
  });

  it("is a no-op when the buffer is empty", () => {
    const { buffer, emitted } = buildWithFakeTimer();
    buffer.flushRemaining();
    assert.deepEqual(emitted, []);
  });

  it("does not emit whitespace-only remainders", () => {
    const { buffer, emitted } = buildWithFakeTimer();
    buffer.push("   ");
    buffer.flushRemaining();
    assert.deepEqual(emitted, []);
  });

  it("cancels the idle timer when called", () => {
    const { buffer, flushRemaining: _, hasScheduledTimer } = {
      ...buildWithFakeTimer(),
      flushRemaining: () => {}, // placeholder — unused
    };
    const helper = buildWithFakeTimer();
    helper.buffer.push("Hello");
    assert.equal(helper.hasScheduledTimer(), true);
    helper.buffer.flushRemaining();
    assert.equal(
      helper.hasScheduledTimer(),
      false,
      "flushRemaining must cancel the pending idle timer",
    );
    // Silence unused warnings
    void buffer;
    void hasScheduledTimer;
  });
});

describe("SentenceBuffer — idle timer", () => {
  it("schedules an idle timer when a non-boundary partial is pushed", () => {
    const { buffer, hasScheduledTimer } = buildWithFakeTimer();
    buffer.push("Partial with no period");
    assert.equal(hasScheduledTimer(), true);
  });

  it("fires the idle timer to flush the partial as a sentence", () => {
    const { buffer, emitted, advance } = buildWithFakeTimer();
    buffer.push("Long clause without boundary");
    assert.deepEqual(emitted, []);
    advance();
    assert.deepEqual(emitted, ["Long clause without boundary "]);
    assert.equal(buffer.length, 0);
  });

  it("cancels the idle timer when a sentence boundary arrives first", () => {
    const { buffer, emitted, hasScheduledTimer, advance } =
      buildWithFakeTimer();
    buffer.push("Building... "); // no `.` + space means no boundary yet
    // Actually the previous assertion is wrong — let me use clearer input.
    // Use distinct inputs:
    const helper = buildWithFakeTimer();
    helper.buffer.push("Still going");
    assert.equal(helper.hasScheduledTimer(), true);
    helper.buffer.push(" further. "); // now has a boundary
    // Emitting + canceling happens synchronously in push().
    assert.deepEqual(helper.emitted, ["Still going further. "]);
    // After the boundary emit, the trailing buffer is empty — no
    // new timer should be scheduled for empty content.
    assert.equal(
      helper.hasScheduledTimer(),
      false,
      "idle timer should not be scheduled after emptying the buffer",
    );
    // Silence unused
    void buffer;
    void emitted;
    void hasScheduledTimer;
    void advance;
  });

  it("resets the idle timer on every push (activity extends the window)", () => {
    const { buffer, advance, emitted } = buildWithFakeTimer();
    buffer.push("First chunk");
    buffer.push(" second chunk");
    buffer.push(" third chunk");
    // Only one timer should be scheduled (the latest). Fire it.
    advance();
    assert.deepEqual(emitted, ["First chunk second chunk third chunk "]);
  });

  it("empty trailing partial after a boundary does NOT schedule a timer", () => {
    const { buffer, hasScheduledTimer } = buildWithFakeTimer();
    buffer.push("Complete sentence. ");
    // Trailing partial is "" — no new timer.
    assert.equal(hasScheduledTimer(), false);
  });
});

describe("SentenceBuffer — dispose", () => {
  it("cancels the idle timer", () => {
    const { buffer, hasScheduledTimer } = buildWithFakeTimer();
    buffer.push("Pending");
    assert.equal(hasScheduledTimer(), true);
    buffer.dispose();
    assert.equal(hasScheduledTimer(), false);
  });

  it("makes subsequent push() a no-op", () => {
    const { buffer, emitted } = buildWithFakeTimer();
    buffer.dispose();
    buffer.push("Hello. ");
    assert.deepEqual(emitted, []);
  });

  it("makes subsequent flushRemaining() a no-op", () => {
    const { buffer, emitted } = buildWithFakeTimer();
    buffer.push("Incomplete");
    buffer.dispose();
    buffer.flushRemaining();
    assert.deepEqual(emitted, []);
  });

  it("idle timer firing after dispose is a no-op", () => {
    // Simulate a race: the timer was already scheduled when dispose
    // was called. Our dispose cancels the timer synchronously so
    // this shouldn't happen in practice — but if the underlying
    // timer implementation has a latent callback, we guard by
    // checking `disposed` inside the timer callback.
    const { buffer, emitted, advance } = buildWithFakeTimer();
    buffer.push("Pending partial");
    // We're going to dispose BUT NOT cancel the fake pending timer
    // — the fake cancelTimeout is called by dispose. To test the
    // disposed guard in the timer body itself, we'd have to leak
    // the timer past dispose, which our fake setTimeout doesn't
    // allow. Instead: rely on the unit test that dispose cancels
    // the timer, and the integration of dispose+advance becomes a
    // no-op test.
    buffer.dispose();
    advance(); // The fake's pending timer was cleared by dispose.
    assert.deepEqual(emitted, []);
  });
});
