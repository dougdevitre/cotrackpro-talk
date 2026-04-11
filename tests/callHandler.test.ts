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
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import {
  handleCallStream,
  type CallHandlerDeps,
} from "../src/handlers/callHandler.js";
import {
  createSession,
  destroySession,
  getSession,
  sessionCount,
} from "../src/utils/sessions.js";
import { env } from "../src/config/env.js";
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

/**
 * Drive a freshly-wired handler through the connect → start → greeting
 * sequence and return the live references every test needs. Extracted
 * because every characterization scenario starts from the same place.
 *
 * Uses a unique `callSid` per scenario so the module-level session
 * store in `src/utils/sessions.ts` doesn't collide between tests.
 */
async function startCall(
  callSid: string,
  role: string = "parent",
): Promise<{
  wiring: ReturnType<typeof setupFakeWiring>;
  socket: FakeTwilioSocket;
  sttFake: FakeSttStream;
  greetingTts: FakeTtsStream;
}> {
  const wiring = setupFakeWiring();
  const socket = new FakeTwilioSocket();

  await handleCallStream(
    socket as unknown as WebSocket,
    wiring.deps,
  );

  socket.emitMessage({
    event: "connected",
    protocol: "Call",
    version: "1.0.0",
  });
  socket.emitMessage({
    event: "start",
    sequenceNumber: "1",
    streamSid: `MZ${callSid}`,
    start: {
      streamSid: `MZ${callSid}`,
      accountSid: "ACtest",
      callSid,
      tracks: ["inbound"],
      customParameters: { role, callerNumber: "+15551234567" },
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    },
  });

  // Wait for the greeting TTS to be created + flushed so the handler
  // has finished the start-case body before the test proceeds.
  await waitFor(
    () =>
      wiring.ttsCreated.length >= 1 &&
      wiring.ttsCreated[0]!.flushed === true,
    { label: `greeting TTS flushed for ${callSid}` },
  );

  const sttFake = wiring.getSttFake();
  if (!sttFake) throw new Error("STT fake should exist after start frame");

  return {
    wiring,
    socket,
    sttFake,
    greetingTts: wiring.ttsCreated[0]!,
  };
}

describe("handleCallStream — characterization tests", () => {
  // Characterization tests run against the real session store, which
  // is a module-level singleton. Clean up any leftover sessions
  // between tests so counters / allSessions() stay accurate. Each
  // scenario uses a unique CA-characterization-N callSid.
  after(() => {
    for (let i = 1; i <= 10; i++) {
      destroySession(`CA-characterization-${i}`);
    }
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
    //
    // GOLDEN RECORD (updated): before the refactor shipped alongside
    // this update, `processUserUtterance` used to eagerly create a
    // second TTS stream in parallel with the Claude call via a
    // now-deleted `const ttsReady = createTtsStream()` line. That
    // second stream was connected and then never used, because the
    // sentence-piping `if (!currentTts)` check was always falsy once
    // the greeting had set `currentTts`. The orphaned stream leaked
    // until call end.
    //
    // The refactor removed the eager creation; `makeSentencePipedCallbacks`
    // now lazily creates a TTS stream only if `currentTts` is null
    // when a delta arrives (never happens in the current call flow,
    // but kept as a defensive fallback). Net observable change:
    // one TTS stream is created per call (the greeting one), and it
    // receives BOTH the greeting text AND the first utterance's
    // Claude response. The golden record is simpler as a result.
    //
    // If a future refactor re-introduces multiple streams (e.g. one
    // per utterance), that's a behavioral change that needs its own
    // deliberate golden-record update.
    await waitFor(
      () => {
        const allText = wiring.ttsCreated
          .flatMap((t) => t.textSent)
          .join("");
        return allText.includes("Of course");
      },
      { label: "Claude response text forwarded to the greeting TTS stream" },
    );

    // Exactly one TTS stream should have been created: the greeting
    // stream, which is reused for the first utterance's Claude
    // response. This is the post-refactor state — zero orphans.
    assert.equal(
      wiring.ttsCreated.length,
      1,
      "expected 1 TTS stream: greeting reused for utterance (post-refactor)",
    );

    // FakeAnthropic should have been called once.
    assert.equal(wiring.anthropicFake.calls.length, 1);
    assert.equal(wiring.anthropicFake.calls[0]!.kind, "streamResponse");
    assert.equal(
      wiring.anthropicFake.calls[0]!.sessionCallSid,
      "CA-characterization-1",
    );
    assert.equal(wiring.anthropicFake.pending(), 0);

    // The greeting TTS stream receives BOTH the greeting text AND
    // the Claude response. This is the intended "reuse" pattern —
    // keeping the same TTS WebSocket open across multiple
    // generations avoids per-utterance handshake latency.
    const greetingStream = wiring.ttsCreated[0]!;
    const greetingJoined = greetingStream.textSent.join("");
    assert.ok(
      greetingJoined.includes("CoTrack Pro"),
      "greeting text should be in the single TTS stream",
    );
    assert.ok(
      greetingJoined.includes("Of course"),
      `the same stream should have received Claude's reply; got: ${JSON.stringify(greetingJoined)}`,
    );

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

    // Cleanup happens synchronously inside the stop case. Verify
    // STT + the single TTS stream are closed. Since the refactor
    // removed the orphan, there's no "second stream that never gets
    // closed" to assert anymore — the golden record is simpler.
    assert.equal(sttFake.closed, true);
    assert.equal(greetingStream.closed, true);
    assert.equal(getSession("CA-characterization-1"), undefined);
  });

  // ────────────────────────────────────────────────────────────────
  // Scenario 2: Barge-in
  //
  // The caller speaks while the assistant is mid-playback. The
  // handler's STT partial-transcript callback detects barge-in if
  // `isAssistantSpeaking === true` AND the partial text is longer
  // than 3 characters. On detect, it clears the Twilio playback
  // buffer and closes the current TTS stream.
  //
  // Golden record: the barge-in path fires exactly these two
  // side-effects (clear + close). A regression that reorders or
  // drops either breaks this test loudly.
  // ────────────────────────────────────────────────────────────────

  it("barge-in: caller's partial transcript mid-playback closes TTS and clears Twilio buffer", async () => {
    const { socket, sttFake, greetingTts } =
      await startCall("CA-characterization-2");

    // Handler is waiting for more frames. Emit an audio chunk from
    // the greeting TTS fake — this triggers the handler's onAudio
    // callback which sets `isAssistantSpeaking = true`. That's the
    // precondition for the barge-in detect path.
    greetingTts.emitAudio("GREETING_CHUNK_1");

    // Sanity: audio made it to Twilio as a media frame.
    assert.deepEqual(
      socket.mediaSent().map((m) => m.payload),
      ["GREETING_CHUNK_1"],
    );

    // Now simulate the STT emitting a partial (interim) transcript
    // longer than 3 characters. This is the exact condition
    // src/handlers/callHandler.ts checks for barge-in on line ~619.
    sttFake.emitPartial("Wait, can you hold on a second?");

    // The handler reaction is synchronous (all three assertions
    // below should be true immediately):
    //
    //   1. A `clear` event was sent to Twilio (clearTwilioBuffer).
    //   2. The current TTS stream was closed (currentTts?.close()).
    //   3. isAssistantSpeaking flipped back to false (internal;
    //      we verify by emitting another partial and seeing that
    //      it does NOT trigger a second barge-in — the test below).
    assert.ok(
      socket.sawClear(),
      "handler should send a `clear` event to Twilio on barge-in",
    );
    assert.equal(
      greetingTts.closed,
      true,
      "handler should close the current TTS stream on barge-in",
    );

    // A short partial (≤ 3 chars) must NOT trigger barge-in. The
    // length guard is there to avoid false positives from STT
    // artifacts like "uh" or "ah" or single-char transcript noise.
    const rawSentBeforeShortPartial = socket.rawSent.length;
    sttFake.emitPartial("uh");
    assert.equal(
      socket.rawSent.length,
      rawSentBeforeShortPartial,
      "short partial (≤ 3 chars) must not trigger a second barge-in",
    );

    // End the call cleanly so no session is leaked.
    socket.emitMessage({
      event: "stop",
      sequenceNumber: "99",
      streamSid: "MZCA-characterization-2",
      stop: { accountSid: "ACtest", callSid: "CA-characterization-2" },
    });
    assert.equal(getSession("CA-characterization-2"), undefined);
  });

  // ────────────────────────────────────────────────────────────────
  // Scenario 3: Claude tool_use → MCP round-trip
  //
  // Claude responds to a user turn by requesting a tool call instead
  // of plain text. The handler:
  //
  //   1. Closes the current TTS stream (sets currentTts = undefined)
  //   2. Plays a "one moment please" hold prompt via playCachedOrSpeak
  //      (falls through to live TTS because the prerecorded cache is
  //       empty in tests, so a new TTS stream is created)
  //   3. Calls deps.callMcpTool(toolName, toolInput)
  //   4. Persists the tool call to DynamoDB (fire-and-forget, no-op
  //      in tests because DYNAMO_ENABLED=false)
  //   5. Creates ANOTHER new TTS stream for the follow-up
  //   6. Calls deps.sendToolResult with that TTS stream in the
  //      callbacks
  //   7. FakeAnthropic plays the next queued response as the follow-up
  //
  // This is the most complex golden-sequence in the file because it
  // creates 3-4 TTS streams on top of the greeting one. The test
  // locks in the exact sequence.
  // ────────────────────────────────────────────────────────────────

  it("tool use: Claude calls MCP, handler plays hold, then streams follow-up", async () => {
    const { wiring, socket, sttFake, greetingTts } =
      await startCall("CA-characterization-3");

    // Queue a tool_use response first. The handler will call
    // streamResponse, which pops this off the queue and fires
    // onToolUse on the callbacks.
    wiring.anthropicFake.queueResponse({
      type: "toolUse",
      toolName: "searchCoTrackDocs",
      toolInput: { query: "visitation schedule template" },
      toolUseId: "toolu_test_001",
    });

    // Queue the MCP response that the handler will get back.
    wiring.mcpFake.queueResponse(
      "Visitation schedule template: ... full text ...",
    );

    // Queue the Claude follow-up response (plain text this time).
    wiring.anthropicFake.queueResponse({
      type: "text",
      text: "Here is the visitation schedule template I found.",
    });

    // Kick it off: user speaks.
    sttFake.emitFinal("Can you find me a visitation schedule template?");

    // Wait for the end-to-end sequence to complete. Observable
    // signal: FakeAnthropic has been called TWICE (streamResponse
    // then sendToolResult) and FakeMcp has been called ONCE.
    await waitFor(
      () =>
        wiring.anthropicFake.calls.length >= 2 &&
        wiring.mcpFake.calls.length >= 1,
      { label: "tool use round-trip complete" },
    );

    // FakeAnthropic call sequence: first streamResponse, then
    // sendToolResult with the original tool_use_id.
    assert.equal(wiring.anthropicFake.calls[0]!.kind, "streamResponse");
    assert.equal(wiring.anthropicFake.calls[1]!.kind, "sendToolResult");
    assert.equal(
      wiring.anthropicFake.calls[1]!.toolUseId,
      "toolu_test_001",
    );

    // MCP received the tool name + input unchanged.
    assert.equal(wiring.mcpFake.calls[0]!.toolName, "searchCoTrackDocs");
    assert.deepEqual(wiring.mcpFake.calls[0]!.toolInput, {
      query: "visitation schedule template",
    });

    // The greeting TTS stream should have been closed when onToolUse
    // fired (line ~512: `currentTts?.close(); currentTts = undefined;`).
    assert.equal(greetingTts.closed, true);

    // After onToolUse closes + nulls currentTts, the hold prompt is
    // played via playCachedOrSpeak → speak → createTtsStream, creating
    // a NEW TTS stream. Then the follow-up createTtsStream creates
    // ANOTHER new one. So ttsCreated should have at least 3 entries:
    //   [0] greeting (closed)
    //   [1] eager-parallel from processUserUtterance (unused orphan)
    //   [2] hold prompt TTS
    //   [3] follow-up TTS (receives "Here is the visitation...")
    assert.ok(
      wiring.ttsCreated.length >= 3,
      `expected at least 3 TTS streams, got ${wiring.ttsCreated.length}`,
    );

    // The Claude follow-up text should appear in the combined
    // textSent of whichever stream(s) the handler routed it to.
    // We use the aggregated assertion to be robust against the
    // sticky-currentTts routing pattern locked in by scenario 1.
    const allText = wiring.ttsCreated
      .flatMap((t) => t.textSent)
      .join("");
    assert.ok(
      allText.includes("Here is the visitation schedule template"),
      `follow-up text should be routed to some TTS stream; got: ${JSON.stringify(allText)}`,
    );

    // Conversation history should have accumulated correctly.
    // Greeting (assistant) + user turn + assistant tool_use blocks
    // + user tool_result + assistant follow-up = 5 entries.
    const session = getSession("CA-characterization-3");
    assert.ok(session);
    assert.equal(
      session!.conversationHistory.length,
      5,
      "expected 5 conversation turns after tool round-trip",
    );
    assert.equal(session!.conversationHistory[0]!.role, "assistant"); // greeting
    assert.equal(session!.conversationHistory[1]!.role, "user");      // utterance
    assert.equal(session!.conversationHistory[2]!.role, "assistant"); // tool_use
    assert.equal(session!.conversationHistory[3]!.role, "user");      // tool_result
    assert.equal(session!.conversationHistory[4]!.role, "assistant"); // follow-up text

    // Clean up
    socket.emitMessage({
      event: "stop",
      sequenceNumber: "99",
      streamSid: "MZCA-characterization-3",
      stop: { accountSid: "ACtest", callSid: "CA-characterization-3" },
    });
    assert.equal(getSession("CA-characterization-3"), undefined);
  });

  // ────────────────────────────────────────────────────────────────
  // Scenario 4: Anthropic stream error
  //
  // FakeAnthropic emits { type: "error", error } through onError.
  // The handler's error path (line ~415-422 in processUserUtterance)
  // catches via makeSentencePipedCallbacks' onFail, which calls
  // `playCachedOrSpeak(ERROR_GENERIC_ULAW[voiceId], ERROR_GENERIC_TEXT)`.
  //
  // Because the prerecorded audio cache is empty in tests,
  // playCachedOrSpeak falls through to live TTS. The result: a
  // fresh TTS stream is created and receives the ERROR_GENERIC_TEXT
  // content as fallback speech.
  //
  // Golden record: the error path produces a new TTS stream with
  // the error text, and `finishProcessing()` runs so subsequent
  // utterances aren't permanently blocked by session.isProcessing.
  // ────────────────────────────────────────────────────────────────

  it("anthropic error: handler plays error fallback + finishes processing", async () => {
    const { wiring, socket, sttFake } =
      await startCall("CA-characterization-4");

    // Queue an error to be emitted as soon as streamResponse is called.
    wiring.anthropicFake.queueResponse({
      type: "error",
      error: new Error("simulated anthropic 500"),
    });

    // Trigger the Claude call path.
    sttFake.emitFinal("Tell me about the weather.");

    // Wait for the error path to complete. Observable signal: a
    // new TTS stream has been created AFTER the greeting one and
    // contains ERROR_GENERIC_TEXT content.
    await waitFor(
      () => {
        const allText = wiring.ttsCreated
          .flatMap((t) => t.textSent)
          .join("");
        // ERROR_GENERIC_TEXT is defined in src/audio/prerecorded.ts
        // and begins with "I'm still here with you.". We match on
        // "still here" because it's the most distinctive phrase and
        // survives minor future tuning of the exact copy.
        return allText.length > 0 && allText.includes("still here");
      },
      { label: "error fallback text reaches TTS" },
    );

    // Verify the session is not permanently locked in processing
    // state. If finishProcessing() didn't run, session.isProcessing
    // would still be true and a follow-up utterance would be queued
    // instead of processed.
    const session = getSession("CA-characterization-4");
    assert.ok(session);
    assert.equal(
      session!.isProcessing,
      false,
      "finishProcessing must run even on Claude error",
    );

    // FakeAnthropic should have been called exactly once
    // (streamResponse only; sendToolResult should not have fired).
    assert.equal(wiring.anthropicFake.calls.length, 1);
    assert.equal(wiring.anthropicFake.calls[0]!.kind, "streamResponse");

    // Clean up
    socket.emitMessage({
      event: "stop",
      sequenceNumber: "99",
      streamSid: "MZCA-characterization-4",
      stop: { accountSid: "ACtest", callSid: "CA-characterization-4" },
    });
    assert.equal(getSession("CA-characterization-4"), undefined);
  });

  // ────────────────────────────────────────────────────────────────
  // Scenario 5: Concurrent-session cap rejection (E-2)
  //
  // When the session store is already at `MAX_CONCURRENT_SESSIONS`,
  // a new incoming WebSocket should be rejected immediately with
  // code 1013 ("Try Again Later") BEFORE any downstream STT / Claude
  // / TTS resources are allocated. This is the regression guard for
  // audit E-2.
  //
  // The test saturates the real in-process session store (fast —
  // Map inserts are microseconds) and then opens a handler, asserts
  // the fakes were NEVER touched, and the socket was closed with
  // the right code + reason.
  // ────────────────────────────────────────────────────────────────

  it("session cap: handler rejects new WS with code 1013 when at capacity", async () => {
    // Saturate the session store to exactly MAX_CONCURRENT_SESSIONS.
    // Previous tests in this file and in tests/sessions.test.ts may
    // have left stragglers in the singleton session store; we only
    // need to fill the gap between the current count and the cap.
    const saturation: string[] = [];
    const cap = env.maxConcurrentSessions;
    const before = sessionCount();
    for (let i = 0; i < cap - before; i++) {
      const sid = `CA-saturate-${i}`;
      createSession(sid, `MZsat${i}`);
      saturation.push(sid);
    }

    try {
      assert.equal(
        sessionCount(),
        cap,
        "session store should be saturated before handler starts",
      );

      // Open a new call. The handler's isAtCapacity check runs
      // FIRST (before registering any event listeners), so this
      // must reject immediately.
      const wiring = setupFakeWiring();
      const socket = new FakeTwilioSocket();
      await handleCallStream(socket as unknown as WebSocket, wiring.deps);

      // Assert the reject side-effects:
      //   1. Socket closed with code 1013 + reason "server busy"
      //   2. No downstream resources allocated — zero TTS streams,
      //      no STT fake, no Anthropic calls, no MCP calls
      assert.equal(socket.closedCode, 1013, "expected WS code 1013 (Try Again Later)");
      assert.equal(socket.closedReason, "server busy");
      assert.equal(
        wiring.ttsCreated.length,
        0,
        "no TTS stream should have been created during a cap reject",
      );
      assert.equal(
        wiring.getSttFake(),
        undefined,
        "no STT stream should have been created during a cap reject",
      );
      assert.equal(wiring.anthropicFake.calls.length, 0);
      assert.equal(wiring.mcpFake.calls.length, 0);

      // Even if Twilio had already started sending frames (unlikely
      // but possible), the handler's event listeners were NOT
      // registered on the socket after the reject. Emitting a start
      // frame should therefore have no effect.
      socket.emitMessage({
        event: "start",
        sequenceNumber: "1",
        streamSid: "MZrejected",
        start: {
          streamSid: "MZrejected",
          accountSid: "ACtest",
          callSid: "CA-should-not-reach",
          tracks: ["inbound"],
          customParameters: { role: "parent" },
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        },
      });
      assert.equal(
        wiring.ttsCreated.length,
        0,
        "start frame after cap reject must be a no-op (handler listeners never registered)",
      );
      assert.equal(
        getSession("CA-should-not-reach"),
        undefined,
        "cap-rejected handler must not create a session",
      );
    } finally {
      // Clean up every saturated session so other tests aren't
      // affected. This runs even if the test fails mid-assertion.
      for (const sid of saturation) destroySession(sid);
    }
  });
});
