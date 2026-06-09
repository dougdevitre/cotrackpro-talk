/**
 * tests/voiceConsent.test.ts — the voice-consent gate.
 *
 * setupEnvVoiceConsent turns REQUIRE_VOICE_CONSENT on, so placeVoiceCall
 * must refuse (403) a request that doesn't attest `consent: true`, and
 * proceed when it does. A robocall must never go out un-attested.
 */

import "./helpers/setupEnvVoiceConsent.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  placeVoiceCall,
  _setVoiceCallerForTests,
} from "../src/core/voiceOutbound.js";
import {
  _resetKvForTests,
  _setKvForTests,
  _MemoryKvForTests as MemoryKv,
} from "../src/services/kv.js";
import { _resetPhoneValidationCacheForTests } from "../src/core/phoneValidation.js";

beforeEach(() => {
  _setKvForTests(new MemoryKv());
  _resetPhoneValidationCacheForTests();
});
afterEach(() => {
  _setVoiceCallerForTests(null);
  _resetKvForTests();
});

describe("placeVoiceCall — voice-consent gate", () => {
  it("403s and does NOT place a call when consent is not attested", async () => {
    let calls = 0;
    _setVoiceCallerForTests(async () => {
      calls++;
      return { callSid: "CA_should_not_happen" };
    });

    const r = await placeVoiceCall({
      to: "+15551230123",
      voiceId: "doug-voice",
      line: "hi",
      dedupeKey: "consent-1",
      // no consent field
    });

    assert.equal(r.status, 403);
    if (!r.ok) assert.match(r.body.error, /consent/);
    assert.equal(calls, 0, "no robocall without attested consent");
  });

  it("403s when consent is explicitly false", async () => {
    const r = await placeVoiceCall({
      to: "+15551230123",
      voiceId: "doug-voice",
      line: "hi",
      dedupeKey: "consent-2",
      consent: false,
    });
    assert.equal(r.status, 403);
  });

  it("places the call when consent: true is attested", async () => {
    let calls = 0;
    _setVoiceCallerForTests(async () => {
      calls++;
      return { callSid: "CA_ok" };
    });

    const r = await placeVoiceCall({
      to: "+15551230123",
      voiceId: "doug-voice",
      line: "hi",
      dedupeKey: "consent-3",
      consent: true,
    });

    assert.equal(r.status, 200);
    if (r.ok) assert.equal(r.body.callSid, "CA_ok");
    assert.equal(calls, 1);
  });

  it("does NOT cache the 403 — a retry after the hub starts attesting proceeds", async () => {
    _setVoiceCallerForTests(async () => ({ callSid: "CA_retry" }));

    const blocked = await placeVoiceCall({
      to: "+15551230123",
      voiceId: "doug-voice",
      line: "hi",
      dedupeKey: "consent-retry",
    });
    assert.equal(blocked.status, 403);

    const retry = await placeVoiceCall({
      to: "+15551230123",
      voiceId: "doug-voice",
      line: "hi",
      dedupeKey: "consent-retry",
      consent: true,
    });
    assert.equal(retry.status, 200);
  });
});
