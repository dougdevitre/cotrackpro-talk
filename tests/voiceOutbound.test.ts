/**
 * tests/voiceOutbound.test.ts — One-shot outbound voice core
 * (src/core/voiceOutbound.ts).
 *
 * setupEnvVoice sets the shared bearer (auth path exercised), a
 * format-valid ELEVENLABS_VOICE_ID_DOUG (so "doug-voice" resolves), and a
 * low CALL_DAILY_CAP=3 (so the per-day cap test trips quickly). The
 * Twilio call placer is injected so no real call is ever made.
 */

import "./helpers/setupEnvVoice.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeVoiceOutbound,
  checkVoiceOutboundRateLimit,
  placeVoiceCall,
  _setVoiceCallerForTests,
  type VoiceCaller,
} from "../src/core/voiceOutbound.js";
import {
  _resetKvForTests,
  _setKvForTests,
  _MemoryKvForTests as MemoryKv,
} from "../src/services/kv.js";
import { _resetPhoneValidationCacheForTests } from "../src/core/phoneValidation.js";
import { suppress } from "../src/core/consent.js";

const RESOLVED_DOUG = "DougVoiceId0000000000";

beforeEach(() => {
  _setKvForTests(new MemoryKv());
  _resetPhoneValidationCacheForTests();
});
afterEach(() => {
  _setVoiceCallerForTests(null);
  _resetKvForTests();
});

describe("authorizeVoiceOutbound", () => {
  it("rejects a missing bearer with 401", () => {
    assert.equal(authorizeVoiceOutbound(undefined)?.status, 401);
  });
  it("rejects a wrong bearer with 401", () => {
    assert.equal(authorizeVoiceOutbound("Bearer nope")?.status, 401);
  });
  it("accepts the shared bearer (returns null)", () => {
    assert.equal(authorizeVoiceOutbound("Bearer test-shared-bearer"), null);
  });
});

describe("placeVoiceCall — validation", () => {
  it("400 on missing 'to'", async () => {
    const r = await placeVoiceCall({ voiceId: "doug-voice", line: "hi" });
    assert.equal(r.status, 400);
  });

  it("400 on missing / empty 'line'", async () => {
    const r = await placeVoiceCall({ to: "+15551230123", voiceId: "doug-voice", line: "   " });
    assert.equal(r.status, 400);
    if (!r.ok) assert.match(r.body.error, /line/);
  });

  it("400 on a non-E.164 destination", async () => {
    const r = await placeVoiceCall({ to: "5551230123", voiceId: "doug-voice", line: "hi" });
    assert.equal(r.status, 400);
  });

  it("400 on an invalid voiceId", async () => {
    const r = await placeVoiceCall({ to: "+15551230123", voiceId: "no spaces!", line: "hi" });
    assert.equal(r.status, 400);
    if (!r.ok) assert.match(r.body.error, /voiceId/);
  });
});

describe("placeVoiceCall — place + idempotency", () => {
  it("resolves doug-voice and places one call returning {callSid}", async () => {
    let calls = 0;
    let seenVoiceId = "";
    const placer: VoiceCaller = async ({ to, voiceId, twiml }) => {
      calls++;
      assert.equal(to, "+15551230123");
      seenVoiceId = voiceId;
      assert.match(twiml, /<Play>.*voice-line\?id=/);
      return { callSid: "CA_test_1" };
    };
    _setVoiceCallerForTests(placer);

    const r = await placeVoiceCall({
      to: "+15551230123",
      voiceId: "doug-voice",
      line: "Hi, it's Doug — your hearing is at 9am tomorrow.",
      dedupeKey: "call-abc",
    });

    assert.equal(r.status, 200);
    if (r.ok) assert.equal(r.body.callSid, "CA_test_1");
    assert.equal(seenVoiceId, RESOLVED_DOUG, "doug-voice resolved to the SSM voice id");
    assert.equal(calls, 1);
  });

  it("is idempotent on dedupeKey — second call replays, placer runs once", async () => {
    let calls = 0;
    _setVoiceCallerForTests(async () => {
      calls++;
      return { callSid: `CA_${calls}` };
    });

    const first = await placeVoiceCall({
      to: "+15551230123",
      voiceId: "doug-voice",
      line: "reminder",
      dedupeKey: "dupe-1",
    });
    const second = await placeVoiceCall({
      to: "+15551230123",
      voiceId: "doug-voice",
      line: "reminder",
      dedupeKey: "dupe-1",
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    if (first.ok && second.ok) assert.equal(first.body.callSid, second.body.callSid);
    assert.equal(second.headers?.["X-Idempotent-Replay"], "true");
    assert.equal(calls, 1, "Twilio placer invoked only once");
  });
});

describe("placeVoiceCall — suppression", () => {
  it("returns the 'suppressed' sentinel and does NOT place a call", async () => {
    let calls = 0;
    _setVoiceCallerForTests(async () => {
      calls++;
      return { callSid: "CA_should_not_happen" };
    });
    await suppress("+15551230123");

    const r = await placeVoiceCall({
      to: "+15551230123",
      voiceId: "doug-voice",
      line: "hi",
      dedupeKey: "supp-call",
    });
    assert.equal(r.status, 200);
    if (r.ok) assert.equal(r.body.callSid, "suppressed");
    assert.equal(calls, 0);
  });
});

describe("checkVoiceOutboundRateLimit — per-day cap", () => {
  it("allows up to CALL_DAILY_CAP then returns 429 (limitedBy day)", async () => {
    // setupEnvVoice sets CALL_DAILY_CAP=3.
    for (let i = 0; i < 3; i++) {
      const ok = await checkVoiceOutboundRateLimit("Bearer test-shared-bearer");
      assert.equal(ok, null, `request ${i + 1} should be allowed`);
    }
    const blocked = await checkVoiceOutboundRateLimit("Bearer test-shared-bearer");
    assert.equal(blocked?.status, 429);
    if (blocked && !blocked.ok) {
      assert.match(blocked.body.details ?? "", /day/);
      assert.ok(blocked.body.retryAfterSeconds > 0);
    }
  });
});
