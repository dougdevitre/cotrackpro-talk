/**
 * tests/voiceLine.test.ts — /call/voice-line render endpoint + the signed
 * token round-trip (src/core/voiceOutbound.ts + api/call/voice-line.ts).
 *
 * The ElevenLabs render is injected (renderTtsAudio stub) so no audio is
 * actually synthesized. A valid token (issued by placeVoiceCall) returns
 * audio; an unknown/forged token returns 404.
 */

import "./helpers/setupEnvVoice.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import voiceLine from "../api/call/voice-line.js";
import { mockRequest, mockResponse } from "./helpers/mockHttp.js";
import {
  placeVoiceCall,
  verifyVoiceLineToken,
  _setVoiceCallerForTests,
} from "../src/core/voiceOutbound.js";
import { _setTtsRendererForTests } from "../src/core/tts.js";
import {
  _resetKvForTests,
  _setKvForTests,
  _MemoryKvForTests as MemoryKv,
} from "../src/services/kv.js";
import { _resetPhoneValidationCacheForTests } from "../src/core/phoneValidation.js";

/** Pull the signed token out of the <Play> URL the placer received. */
function tokenFromTwiml(twiml: string): string {
  const m = twiml.match(/voice-line\?id=([^<]+)/);
  assert.ok(m, "twiml should contain a voice-line id");
  return decodeURIComponent(m![1]);
}

beforeEach(() => {
  _setKvForTests(new MemoryKv());
  _resetPhoneValidationCacheForTests();
});
afterEach(() => {
  _setVoiceCallerForTests(null);
  _setTtsRendererForTests(null);
  _resetKvForTests();
});

describe("voice-line token", () => {
  it("rejects a forged / unsigned token", () => {
    assert.equal(verifyVoiceLineToken("abc.def"), null);
    assert.equal(verifyVoiceLineToken("no-dot"), null);
    assert.equal(verifyVoiceLineToken(undefined), null);
  });
});

describe("GET /call/voice-line", () => {
  it("renders + returns audio for a valid token issued by placeVoiceCall", async () => {
    let capturedTwiml = "";
    _setVoiceCallerForTests(async ({ twiml }) => {
      capturedTwiml = twiml;
      return { callSid: "CA_vl" };
    });
    const fakeAudio = Buffer.from("ID3-fake-mp3-bytes");
    let renderedLine = "";
    let renderedVoice = "";
    _setTtsRendererForTests(async (text, voiceId) => {
      renderedLine = text;
      renderedVoice = voiceId;
      return { ok: true, audio: fakeAudio, contentType: "audio/mpeg" };
    });

    await placeVoiceCall({
      to: "+15551230123",
      voiceId: "doug-voice",
      line: "Hi, it's Doug.",
      dedupeKey: "vl-1",
    });
    const token = tokenFromTwiml(capturedTwiml);

    const req = mockRequest({ url: `/api/call/voice-line?id=${encodeURIComponent(token)}`, method: "GET" });
    const { res, getStatus, getHeader } = mockResponse();
    await voiceLine(req, res);

    assert.equal(getStatus(), 200);
    assert.match(getHeader("content-type") ?? "", /audio\/mpeg/);
    assert.equal(renderedLine, "Hi, it's Doug.");
    assert.equal(renderedVoice, "DougVoiceId0000000000");
  });

  it("caches the rendered audio — a second fetch serves bytes without re-rendering", async () => {
    let capturedTwiml = "";
    _setVoiceCallerForTests(async ({ twiml }) => {
      capturedTwiml = twiml;
      return { callSid: "CA_vl2" };
    });
    let renders = 0;
    _setTtsRendererForTests(async () => {
      renders++;
      return { ok: true, audio: Buffer.from("audio-bytes"), contentType: "audio/mpeg" };
    });

    await placeVoiceCall({
      to: "+15551230123",
      voiceId: "doug-voice",
      line: "Reminder.",
      dedupeKey: "vl-cache",
    });
    const token = tokenFromTwiml(capturedTwiml);
    const url = `/api/call/voice-line?id=${encodeURIComponent(token)}`;

    for (let i = 0; i < 3; i++) {
      const { res, getStatus } = mockResponse();
      await voiceLine(mockRequest({ url, method: "GET" }), res);
      assert.equal(getStatus(), 200);
    }
    assert.equal(renders, 1, "ElevenLabs should be billed once across Twilio retries");
  });

  it("405s a non-GET request", async () => {
    const req = mockRequest({ url: "/api/call/voice-line?id=x", method: "POST" });
    const { res, getStatus } = mockResponse();
    await voiceLine(req, res);
    assert.equal(getStatus(), 405);
  });

  it("404s an unknown / forged token", async () => {
    const req = mockRequest({ url: "/api/call/voice-line?id=bogus.deadbeef", method: "GET" });
    const { res, getStatus } = mockResponse();
    await voiceLine(req, res);
    assert.equal(getStatus(), 404);
  });
});
