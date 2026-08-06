/**
 * tests/stt.test.ts — STTStream frame dispatch.
 *
 * STTStream had no test coverage at all: tests/fakes/sttStream.ts is a
 * hand-written stand-in used to drive callHandler, so the real
 * message-parsing code was exercised by nothing. That mattered — a live
 * call spent 51 seconds streaming audio to ElevenLabs and produced no
 * transcript, and the code had no way to say why, because an
 * unrecognized message_type fell through the switch silently.
 *
 * These drive `handleMessage` directly rather than mocking a WebSocket:
 * `new WebSocket()` is constructed inline in connect(), and the dispatch
 * logic is the part worth pinning down.
 */

import "./helpers/setupEnv.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { STTStream } from "../src/services/stt.js";

type Captured = {
  partials: string[];
  finals: string[];
  errors: string[];
};

function makeStream(): { stt: STTStream; got: Captured } {
  const got: Captured = { partials: [], finals: [], errors: [] };
  const stt = new STTStream({
    callSid: "CAtest0000000000000000000000000000",
    onPartial: (t) => got.partials.push(t),
    onFinal: (t) => got.finals.push(t),
    onError: (e) => got.errors.push(e.message),
  });
  return { stt, got };
}

const frame = (o: Record<string, unknown>) => JSON.stringify(o);

describe("STTStream.handleMessage — known frame types", () => {
  let stt: STTStream;
  let got: Captured;
  beforeEach(() => ({ stt, got } = makeStream()));

  it("dispatches a committed transcript to onFinal", () => {
    stt.handleMessage(frame({ message_type: "committed_transcript", text: "hello there" }));
    assert.deepEqual(got.finals, ["hello there"]);
    assert.equal(stt.diagnostics.committed, 1);
  });

  it("dispatches a partial transcript to onPartial", () => {
    stt.handleMessage(frame({ message_type: "partial_transcript", text: "hel" }));
    assert.deepEqual(got.partials, ["hel"]);
    assert.equal(stt.diagnostics.partials, 1);
    assert.equal(stt.diagnostics.committed, 0, "a partial is not a commit");
  });

  it("surfaces an error frame through onError", () => {
    stt.handleMessage(frame({ message_type: "error", error: "quota exceeded" }));
    assert.deepEqual(got.errors, ["quota exceeded"]);
  });

  it("ignores a transcript frame with no text", () => {
    stt.handleMessage(frame({ message_type: "committed_transcript" }));
    stt.handleMessage(frame({ message_type: "partial_transcript", text: "" }));
    assert.deepEqual(got.finals, []);
    assert.deepEqual(got.partials, []);
    assert.equal(stt.diagnostics.committed, 0);
  });

  it("accepts session_started without emitting anything", () => {
    stt.handleMessage(frame({ message_type: "session_started", session_id: "abc123" }));
    assert.deepEqual(got, { partials: [], finals: [], errors: [] });
  });
});

describe("STTStream.handleMessage — unrecognized frames", () => {
  let stt: STTStream;
  let got: Captured;
  beforeEach(() => ({ stt, got } = makeStream()));

  // The bug this exists for: a renamed or added frame type used to be
  // indistinguishable from receiving nothing at all.
  it("records an unknown message type instead of dropping it silently", () => {
    stt.handleMessage(frame({ message_type: "transcript", text: "hello" }));
    assert.deepEqual(stt.diagnostics.unknownTypes, ["transcript"]);
    assert.deepEqual(got.finals, [], "must not guess that it's a transcript");
  });

  it("records each unknown type once, however many arrive", () => {
    for (let i = 0; i < 50; i++) {
      stt.handleMessage(frame({ message_type: "vad_event", n: i }));
    }
    assert.deepEqual(stt.diagnostics.unknownTypes, ["vad_event"]);
  });

  it("distinguishes several unknown types", () => {
    stt.handleMessage(frame({ message_type: "vad_event" }));
    stt.handleMessage(frame({ message_type: "transcript" }));
    assert.deepEqual(stt.diagnostics.unknownTypes.sort(), ["transcript", "vad_event"]);
  });

  it("names a frame with no message_type at all", () => {
    stt.handleMessage(frame({ text: "orphaned" }));
    assert.deepEqual(stt.diagnostics.unknownTypes, ["(absent)"]);
  });

  // Killing a live call over one bad frame is worse than ignoring it.
  it("does not throw on malformed JSON", () => {
    assert.doesNotThrow(() => stt.handleMessage("not json at all"));
    assert.doesNotThrow(() => stt.handleMessage(""));
    assert.deepEqual(got.errors, [], "a parse failure is not an STT error callback");
  });
});

describe("STTStream diagnostics", () => {
  it("starts empty", () => {
    const { stt } = makeStream();
    assert.deepEqual(stt.diagnostics, {
      committed: 0,
      partials: 0,
      unknownTypes: [],
      audioSecs: 0,
    });
  });

  // The signal that separates "transcription works, commits don't" from
  // "nothing is being transcribed" — the two live causes of a silent call.
  it("counts partials and commits independently", () => {
    const { stt } = makeStream();
    stt.handleMessage(frame({ message_type: "partial_transcript", text: "he" }));
    stt.handleMessage(frame({ message_type: "partial_transcript", text: "hello" }));
    stt.handleMessage(frame({ message_type: "committed_transcript", text: "hello" }));
    assert.equal(stt.diagnostics.partials, 2);
    assert.equal(stt.diagnostics.committed, 1);
  });

  it("close() is safe on a stream that never connected", () => {
    const { stt } = makeStream();
    assert.doesNotThrow(() => stt.close());
  });

  it("reports forwarded audio seconds exactly once", () => {
    const seen: number[] = [];
    const stt = new STTStream({
      callSid: "CAtest0000000000000000000000000000",
      onPartial: () => {},
      onFinal: () => {},
      onError: () => {},
      onSeconds: (s) => seen.push(s),
    });
    stt.close();
    stt.close();
    assert.equal(seen.length, 1, "double close must not double-bill");
  });
});
