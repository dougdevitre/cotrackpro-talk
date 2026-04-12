/**
 * tests/callCompletion.test.ts — Unit tests for Pass 3 of the
 * callHandler refactor: the pure call-completion helpers in
 * src/core/callCompletion.ts.
 *
 * These helpers compute the transcript + duration + cost summary
 * that `handleCallStream.cleanup()` persists to DynamoDB. The
 * DynamoDB writes themselves stay in the handler; these functions
 * are side-effect-free and exist to make the logic unit-testable.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompletedTranscript,
  computeDurationSecs,
  finalizeCallCompletion,
} from "../src/core/callCompletion.js";
import type {
  CallSession,
  CoTrackProRole,
} from "../src/types/index.js";

/**
 * Build a minimal in-memory CallSession fixture. Tests pass
 * overrides for whichever fields they're asserting on.
 */
function buildSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    callSid: "CA-completion-test",
    streamSid: "MZ-completion-test",
    role: "parent" as CoTrackProRole,
    voiceId: "test-voice",
    conversationHistory: [],
    isProcessing: false,
    audioBuffer: [],
    silenceStartMs: null,
    createdAt: Date.now() - 60_000, // 1 minute ago
    lastActivityMs: Date.now(),
    costMetrics: {
      claudeInputTokens: 0,
      claudeOutputTokens: 0,
      claudeCacheCreationTokens: 0,
      claudeCacheReadTokens: 0,
      ttsChars: 0,
      ttsCharsCached: 0,
      sttSecs: 0,
    },
    ...overrides,
  };
}

describe("buildCompletedTranscript", () => {
  it("returns an empty array for a session with no turns", () => {
    const session = buildSession();
    assert.deepEqual(buildCompletedTranscript(session), []);
  });

  it("includes string-content turns with role + text + ISO timestamp", () => {
    const t0 = new Date("2026-04-11T12:00:00.000Z").getTime();
    const session = buildSession({
      conversationHistory: [
        { role: "assistant", content: "Hello there.", timestamp: t0 },
        { role: "user", content: "Hi.", timestamp: t0 + 1000 },
        { role: "assistant", content: "How can I help?", timestamp: t0 + 2000 },
      ],
    });
    const transcript = buildCompletedTranscript(session);
    assert.equal(transcript.length, 3);
    assert.deepEqual(transcript[0], {
      role: "assistant",
      text: "Hello there.",
      timestamp: "2026-04-11T12:00:00.000Z",
    });
    assert.equal(transcript[1]!.text, "Hi.");
    assert.equal(transcript[2]!.text, "How can I help?");
  });

  it("drops structured-block turns (tool_use, tool_result)", () => {
    // The real handler pushes assistant-tool_use and user-tool_result
    // as structured block arrays. These shouldn't appear in the
    // human-readable transcript because the dashboard wants plain
    // text.
    const session = buildSession({
      conversationHistory: [
        {
          role: "assistant",
          content: "Let me look that up.",
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "searchDocs", input: {} },
          ],
          timestamp: 2000,
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "..." },
          ],
          timestamp: 3000,
        },
        {
          role: "assistant",
          content: "Here's what I found.",
          timestamp: 4000,
        },
      ],
    });
    const transcript = buildCompletedTranscript(session);
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0]!.text, "Let me look that up.");
    assert.equal(transcript[1]!.text, "Here's what I found.");
  });

  it("does not mutate the input session", () => {
    const session = buildSession({
      conversationHistory: [
        { role: "user", content: "Hello", timestamp: 1000 },
      ],
    });
    const historyBefore = session.conversationHistory.slice();
    buildCompletedTranscript(session);
    assert.deepEqual(
      session.conversationHistory,
      historyBefore,
      "buildCompletedTranscript must be pure",
    );
  });
});

describe("computeDurationSecs", () => {
  it("rounds to the nearest whole second", () => {
    const session = buildSession({ createdAt: 1_000_000 });
    // now = createdAt + 3_600 ms → 3.6s → rounds to 4
    assert.equal(computeDurationSecs(session, 1_003_600), 4);
    // now = createdAt + 3_499 ms → 3.499s → rounds to 3
    assert.equal(computeDurationSecs(session, 1_003_499), 3);
  });

  it("returns 0 for a newly-created session", () => {
    const now = Date.now();
    const session = buildSession({ createdAt: now });
    assert.equal(computeDurationSecs(session, now), 0);
  });

  it("handles multi-minute calls correctly", () => {
    const session = buildSession({ createdAt: 0 });
    // 12 minutes 34.5 seconds → 754.5 → rounds to 755
    assert.equal(computeDurationSecs(session, 754_500), 755);
  });

  it("defaults `now` to Date.now() when not supplied", () => {
    const session = buildSession({ createdAt: Date.now() - 5_000 });
    const secs = computeDurationSecs(session);
    // Allow some slop for test execution time.
    assert.ok(secs >= 4 && secs <= 6, `expected ~5s, got ${secs}`);
  });
});

describe("finalizeCallCompletion", () => {
  it("returns a complete bundle with all expected fields", () => {
    const t0 = Date.parse("2026-04-11T12:00:00.000Z");
    const session = buildSession({
      createdAt: t0,
      conversationHistory: [
        { role: "assistant", content: "Hello.", timestamp: t0 },
        { role: "user", content: "Hi.", timestamp: t0 + 1000 },
      ],
      costMetrics: {
        claudeInputTokens: 100,
        claudeOutputTokens: 50,
        claudeCacheCreationTokens: 200,
        claudeCacheReadTokens: 500,
        ttsChars: 300,
        ttsCharsCached: 100,
        sttSecs: 15,
      },
    });

    const bundle = finalizeCallCompletion(session, t0 + 60_000);

    assert.equal(bundle.durationSecs, 60);
    assert.equal(bundle.turnCount, 2);
    assert.equal(bundle.endedAt, "2026-04-11T12:01:00.000Z");
    assert.equal(bundle.transcript.length, 2);
    assert.equal(bundle.transcript[0]!.role, "assistant");
    assert.equal(bundle.transcript[0]!.text, "Hello.");
    // Cost summary includes the metrics + an estimated USD figure.
    assert.equal(bundle.costSummary.claudeInputTokens, 100);
    assert.equal(bundle.costSummary.claudeOutputTokens, 50);
    assert.ok(
      typeof bundle.costSummary.estimatedCostUsd === "number" &&
        bundle.costSummary.estimatedCostUsd >= 0,
      "estimatedCostUsd should be a non-negative number",
    );
  });

  it("turnCount excludes structured-block turns", () => {
    const session = buildSession({
      conversationHistory: [
        { role: "assistant", content: "Text.", timestamp: 1000 },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
          timestamp: 2000,
        },
        { role: "user", content: "Reply.", timestamp: 3000 },
      ],
    });
    const bundle = finalizeCallCompletion(session);
    // 3 raw turns, 2 string-content turns.
    assert.equal(bundle.turnCount, 2);
    assert.equal(bundle.transcript.length, 2);
  });

  it("does not mutate the input session", () => {
    const session = buildSession({
      conversationHistory: [
        { role: "user", content: "hi", timestamp: 1000 },
      ],
      costMetrics: {
        claudeInputTokens: 10,
        claudeOutputTokens: 5,
        claudeCacheCreationTokens: 0,
        claudeCacheReadTokens: 0,
        ttsChars: 20,
        ttsCharsCached: 0,
        sttSecs: 2,
      },
    });
    const costMetricsBefore = { ...session.costMetrics };
    const historyBefore = session.conversationHistory.slice();
    finalizeCallCompletion(session);
    assert.deepEqual(session.costMetrics, costMetricsBefore);
    assert.deepEqual(session.conversationHistory, historyBefore);
  });
});
