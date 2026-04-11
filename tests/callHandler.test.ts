/**
 * tests/callHandler.test.ts — Characterization test for
 * `src/handlers/callHandler.ts` (the WebSocket call handler).
 *
 * This is the first test in the repo that drives the WebSocket call
 * handler from end to end with the new DI seam. It's intentionally
 * structured as a golden-sequence "characterization" test in the
 * sense of Michael Feathers' Working Effectively with Legacy Code:
 * we don't assert that the current behavior is correct in the
 * absolute sense, we assert that it matches a recorded-from-reality
 * baseline. Any future refactor of `callHandler.ts` that changes
 * this sequence without explicit test update will break loudly.
 *
 * Why characterization over "normal" unit tests:
 *
 *   - `callHandler.ts` is 660 lines of event-driven glue that
 *     previously had no direct test coverage. A full unit-test
 *     breakdown would require a refactor we're not doing yet
 *     (E-6/A-6 in the audit).
 *   - Characterization tests are the safety net the refactor needs.
 *     First we lock down the current behavior, then the refactor
 *     can proceed under the net.
 *   - The DI seam introduced by this same PR (CallHandlerDeps) is
 *     what makes the test possible at all — every external service
 *     is replaced by a scripted fake in tests/fakes/.
 *
 * What this first test covers: the inbound-call happy path with no
 * tool calls, no barge-in, no errors. Call arrives → STT transcribes
 * → Claude responds with plain text → TTS plays → call ends.
 *
 * Future tests in this file should add: barge-in, tool-use /
 * sendToolResult, Anthropic timeout, ElevenLabs connect failure,
 * Twilio close mid-utterance, concurrent-session-cap rejection.
 * Each is its own `it(...)` block calling the same setup helpers.
 */

import "./helpers/setupEnv.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import {
  handleCallStream,
  type CallHandlerDeps,
} from "../src/handlers/callHandler.js";
import { destroySession, getSession } from "../src/utils/sessions.js";
import { FakeTwilioSocket } from "./fakes/twilioSocket.js";
import {
  FakeTtsStream,
  collectingTtsFactory,
} from "./fakes/ttsStream.js";
import { FakeSttStream } from "./fakes/sttStream.js";
import { FakeAnthropic } from "./fakes/anthropic.js";
import { FakeMcp } from "./fakes/mcp.js";

/**
 * Poll `predicate` until it returns true or `timeoutMs` elapses.
 * Used to drain the async microtask chain that `handleCallStream`
 * kicks off when it receives a `start` or `media` event — those
 * handlers do several async awaits that we can't directly await on
 * from the test, so we wait for their observable side-effects to
 * appear.
 *
 * 200ms is a generous ceiling for in-memory chains that normally
 * complete in a handful of microtasks. If a test legitimately needs
 * more, pass `{ timeoutMs }`.
 */
async function waitFor(
  predicate: () => boolean,
  {
    timeoutMs = 200,
    intervalMs = 2,
    label,
  }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${label ? ": " + label : ""}`,
  );
}

/**
 * Build a complete fake wiring for `handleCallStream`. Returns the
 * fakes the test needs to drive + inspect, plus a `deps` object
 * that can be passed straight to `handleCallStream`.
 */
function setupFakeWiring() {
  // FakeSttStream needs to be captured when the handler creates it.
  // Same pattern as collectingTtsFactory — we need a reference from
  // the test side after the handler constructs it internally.
  let sttFake: FakeSttStream | undefined;

  const { factory: makeTtsStream, created: ttsCreated } =
    collectingTtsFactory();
  const anthropicFake = new FakeAnthropic();
  const mcpFake = new FakeMcp();

  const deps: Partial<CallHandlerDeps> = {
    makeTtsStream,
    makeSttStream: (opts) => {
      sttFake = new FakeSttStream(opts);
      return sttFake;
    },
    streamResponse: anthropicFake.streamResponse,
    sendToolResult: anthropicFake.sendToolResult,
    callMcpTool: mcpFake.call,
  };

  return {
    deps,
    ttsCreated,
    anthropicFake,
    mcpFake,
    /** Returns the STT fake once the handler has created it. */
    getSttFake: () => sttFake,
  };
}

describe("handleCallStream — characterization tests", () => {
  // Characterization tests run against the real session store, which
  // is a module-level singleton. Clean up any leftover sessions
  // between tests so counters / allSessions() stay accurate.
  after(() => {
    destroySession("CA-characterization-1");
  });

  it("inbound call happy path: start → transcript → Claude text → TTS → stop", async () => {
    const wiring = setupFakeWiring();
    const socket = new FakeTwilioSocket();

    // `handleCallStream` registers event listeners and returns
    // immediately. All the real work happens in response to events
    // emitted on the socket.
    await handleCallStream(
      socket as unknown as WebSocket,
      wiring.deps,
    );

    // ── 1. Twilio "connected" frame ─────────────────────────────
    // Purely informational — handler logs and moves on. No observable
    // effect in the fake. Included for fidelity to the real flow.
    socket.emitMessage({
      event: "connected",
      protocol: "Call",
      version: "1.0.0",
    });

    // ── 2. Twilio "start" frame ─────────────────────────────────
    // Handler creates the session, initializes STT via our factory,
    // builds the greeting string, and plays it through a freshly-
    // created TTS stream (the prerecorded audio cache is empty in
    // tests, so playCachedOrSpeak falls through to live TTS).
    socket.emitMessage({
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZstream-characterization",
      start: {
        streamSid: "MZstream-characterization",
        accountSid: "ACtest",
        callSid: "CA-characterization-1",
        tracks: ["inbound"],
        customParameters: { role: "parent", callerNumber: "+15551234567" },
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      },
    });

    // The start handler does:
    //   - sttStream = makeSttStream(...)
    //   - await Promise.all([sttStream.connect(), playCachedOrSpeak(...)])
    // and playCachedOrSpeak falls through to `speak(greeting)` which
    // creates a TTS stream, connects it, sendText + flush.
    //
    // Wait until the greeting TTS stream is fully set up so we know
    // the start-handler body has run to completion.
    await waitFor(
      () =>
        wiring.ttsCreated.length >= 1 &&
        wiring.ttsCreated[0]!.flushed === true,
      { label: "greeting TTS flushed" },
    );

    const greetingTts = wiring.ttsCreated[0]!;
    assert.equal(greetingTts.connected, true);
    assert.equal(greetingTts.flushed, true);
    assert.ok(
      greetingTts.textSent.some((t) => t.includes("CoTrack Pro")),
      "greeting should include 'CoTrack Pro' — role-adaptive text from getRoleGreeting",
    );

    // STT should also be connected.
    const sttFake = wiring.getSttFake()!;
    assert.ok(sttFake, "STT fake should have been created by the handler");
    assert.equal(sttFake.connected, true);

    // Session should exist with the right shape.
    const session = getSession("CA-characterization-1");
    assert.ok(session, "session should exist after start frame");
    assert.equal(session!.role, "parent");
    assert.equal(session!.streamSid, "MZstream-characterization");
    // Greeting should be in conversation history as an assistant turn.
    assert.equal(session!.conversationHistory.length, 1);
    assert.equal(session!.conversationHistory[0]!.role, "assistant");

    // ── 3. Greeting audio playback (TTS emits audio) ────────────
    // The real TTS would stream ulaw audio chunks through onAudio.
    // We simulate one chunk + done, then verify the handler forwards
    // the audio to the Twilio socket.
    greetingTts.emitAudio("BASE64_GREETING_CHUNK");
    greetingTts.emitDone();

    await waitFor(() => socket.mediaSent().length >= 1, {
      label: "greeting media forwarded to Twilio",
    });

    assert.deepEqual(
      socket.mediaSent().map((m) => m.payload),
      ["BASE64_GREETING_CHUNK"],
    );
    assert.ok(
      socket.marksSent().length >= 1,
      "handler should send a mark event after TTS onDone",
    );

    // ── 4. Caller speaks → STT emits a final transcript ────────
    // Queue a scripted Claude response FIRST (the handler awaits
    // streamResponse synchronously once the transcript arrives).
    wiring.anthropicFake.queueResponse({
      type: "text",
      text: "Of course. I can help with that.",
    });

    // Emit an audio frame so the media branch is exercised at least once.
    socket.emitMessage({
      event: "media",
      sequenceNumber: "2",
      streamSid: "MZstream-characterization",
      media: {
        track: "inbound",
        chunk: "1",
        timestamp: "1000",
        payload: "AUDIO_FRAME_1",
      },
    });

    // STT should see the media frame.
    assert.deepEqual(sttFake.audioChunks, ["AUDIO_FRAME_1"]);

    // Simulate the final transcript arriving.
    sttFake.emitFinal("I need help with documentation.");

    // Wait for the handler to finish processing the utterance.
    // GOLDEN RECORD: the current production behavior is that Claude's
    // text response ends up on the GREETING TTS stream (index 0),
    // not a new one, because `currentTts` is sticky across utterances.
    // `processUserUtterance` DOES eagerly create a second TTS stream
    // (ttsCreated[1]) via `createTtsStream()` — see the comment in
    // callHandler.ts — but the sentence-piping callbacks only swap to
    // it when `currentTts` is falsy, which it isn't after a greeting
    // via `speak()`. So the second stream is created, connected, and
    // then effectively unused in the happy path. This is a latent
    // resource-leak pattern but it's current production behavior; we
    // lock it in here so any future change surfaces as an explicit
    // test failure rather than a silent behavior shift.
    await waitFor(
      () => {
        // The Claude text should appear in the combined textSent of
        // whichever stream(s) the handler routed it to.
        const allText = wiring.ttsCreated
          .flatMap((t) => t.textSent)
          .join("");
        return allText.includes("Of course");
      },
      { label: "Claude response text forwarded to some TTS stream" },
    );

    // Two TTS streams should have been created: [0] greeting,
    // [1] eager-parallel for the utterance (goes unused).
    assert.equal(
      wiring.ttsCreated.length,
      2,
      "expected 2 TTS streams: greeting + eager-parallel for utterance",
    );

    // FakeAnthropic should have been called once.
    assert.equal(wiring.anthropicFake.calls.length, 1);
    assert.equal(wiring.anthropicFake.calls[0]!.kind, "streamResponse");
    assert.equal(
      wiring.anthropicFake.calls[0]!.sessionCallSid,
      "CA-characterization-1",
    );
    assert.equal(wiring.anthropicFake.pending(), 0);

    // GOLDEN RECORD: the greeting TTS stream (index 0) is where the
    // Claude response is actually sent, because of the sticky
    // currentTts pattern described above.
    const greetingStream = wiring.ttsCreated[0]!;
    const eagerUnusedStream = wiring.ttsCreated[1]!;

    // Greeting text + Claude response both land on the same stream.
    const greetingJoined = greetingStream.textSent.join("");
    assert.ok(
      greetingJoined.includes("CoTrack Pro"),
      "greeting text should be in stream 0",
    );
    assert.ok(
      greetingJoined.includes("Of course"),
      `stream 0 should have received Claude's reply; got: ${JSON.stringify(greetingJoined)}`,
    );

    // The eager-parallel TTS stream was connected but nothing was
    // written to it (sticky-currentTts bypass). This is the golden
    // record of the latent resource-leak pattern.
    assert.equal(eagerUnusedStream.connected, true);
    assert.deepEqual(
      eagerUnusedStream.textSent,
      [],
      "eager TTS stream should have received NO text (sticky currentTts bypass)",
    );
    assert.equal(eagerUnusedStream.flushed, false);

    // Session conversation history should now have: assistant
    // greeting + user turn + assistant reply = 3 entries.
    assert.equal(session!.conversationHistory.length, 3);
    assert.equal(session!.conversationHistory[1]!.role, "user");
    assert.equal(
      session!.conversationHistory[1]!.content,
      "I need help with documentation.",
    );
    assert.equal(session!.conversationHistory[2]!.role, "assistant");
    assert.equal(
      session!.conversationHistory[2]!.content,
      "Of course. I can help with that.",
    );

    // ── 5. Twilio "stop" frame ────────────────────────────────
    // Handler calls cleanup() which closes STT + TTS and destroys
    // the session. DynamoDB writes are fire-and-forget with .catch
    // so we don't need to stub them.
    socket.emitMessage({
      event: "stop",
      sequenceNumber: "3",
      streamSid: "MZstream-characterization",
      stop: { accountSid: "ACtest", callSid: "CA-characterization-1" },
    });

    // Cleanup happens synchronously inside the stop case; no waitFor
    // needed. Verify STT + TTS are closed. Note: cleanup only closes
    // the currently-referenced currentTts (the greeting stream). The
    // eager-parallel stream at index 1 is orphaned — another data
    // point for the latent leak pattern.
    assert.equal(sttFake.closed, true);
    assert.equal(greetingStream.closed, true);
    assert.equal(
      eagerUnusedStream.closed,
      false,
      "eager-parallel TTS stream is never closed — golden record of the orphan",
    );
    assert.equal(getSession("CA-characterization-1"), undefined);
  });
});
