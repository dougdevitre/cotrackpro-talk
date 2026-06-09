/**
 * tests/sms.test.ts — Hub → Talk SMS send (/api/sms/send) core.
 *
 * Covers shared-bearer auth (constant-time), destination validation,
 * idempotency on dedupeKey, and the Twilio send path via an injected
 * sender stub. setupEnvHub sets OUTBOUND_API_KEY so the auth path is
 * actually exercised.
 */

import "./helpers/setupEnvHub.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeInboundSms,
  sendSms,
  buildSmsCreateParams,
  _setSmsSenderForTests,
  type SmsSender,
} from "../src/core/sms.js";
import {
  _resetKvForTests,
  _setKvForTests,
  _MemoryKvForTests as MemoryKv,
} from "../src/services/kv.js";
import { _resetPhoneValidationCacheForTests } from "../src/core/phoneValidation.js";
import { suppress, OPT_OUT_FOOTER } from "../src/core/consent.js";

beforeEach(() => {
  // Fresh KV per test so idempotency + rate-limit state doesn't leak.
  _setKvForTests(new MemoryKv());
  _resetPhoneValidationCacheForTests();
});
afterEach(() => {
  _setSmsSenderForTests(null);
  _resetKvForTests();
});

describe("authorizeInboundSms", () => {
  it("rejects a missing bearer with 401", () => {
    const r = authorizeInboundSms(undefined);
    assert.equal(r?.status, 401);
  });

  it("rejects a wrong bearer with 401", () => {
    const r = authorizeInboundSms("Bearer not-the-key");
    assert.equal(r?.status, 401);
  });

  it("accepts the shared bearer (returns null)", () => {
    assert.equal(authorizeInboundSms("Bearer test-shared-bearer"), null);
  });
});

describe("buildSmsCreateParams — A2P attribution", () => {
  it("sends through the Messaging Service SID, not a bare from-number", () => {
    // setupEnvHub sets TWILIO_MESSAGING_SERVICE_SID.
    const params = buildSmsCreateParams("+15551230123", "hi");
    assert.equal(params.messagingServiceSid, "MGtest0000000000000000000000000000");
    assert.equal(params.from, undefined);
    assert.equal(params.to, "+15551230123");
    assert.equal(params.body, "hi");
  });
});

describe("sendSms — validation", () => {
  it("400 on missing 'to'", async () => {
    const r = await sendSms({ body: "hi" });
    assert.equal(r.status, 400);
  });

  it("400 on missing 'body'", async () => {
    const r = await sendSms({ to: "+15551230123" });
    assert.equal(r.status, 400);
  });

  it("400 on a non-E.164 / disallowed destination", async () => {
    const r = await sendSms({ to: "5551230123", body: "hi" });
    assert.equal(r.status, 400);
    if (!r.ok) assert.match(r.body.error, /invalid 'to'/);
  });
});

describe("sendSms — send + idempotency", () => {
  it("sends via Twilio and returns the sid", async () => {
    let calls = 0;
    const sender: SmsSender = async ({ to, body }) => {
      calls++;
      assert.equal(to, "+15551230123");
      assert.equal(body, "your sign-in link: https://example.com/x");
      return { sid: "SM_test_1" };
    };
    _setSmsSenderForTests(sender);

    const r = await sendSms({
      to: "+15551230123",
      body: "your sign-in link: https://example.com/x",
    });
    assert.equal(r.status, 200);
    if (r.ok) assert.equal(r.body.sid, "SM_test_1");
    assert.equal(calls, 1);
  });

  it("is idempotent on dedupeKey — second call replays, sender runs once", async () => {
    let calls = 0;
    _setSmsSenderForTests(async () => {
      calls++;
      return { sid: `SM_${calls}` };
    });

    const first = await sendSms({
      to: "+15551230123",
      body: "hello",
      dedupeKey: "dedupe-abc",
    });
    const second = await sendSms({
      to: "+15551230123",
      body: "hello",
      dedupeKey: "dedupe-abc",
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    if (first.ok && second.ok) assert.equal(first.body.sid, second.body.sid);
    assert.equal(second.headers?.["X-Idempotent-Replay"], "true");
    assert.equal(calls, 1); // sender invoked only once
  });

  it("does NOT modify the body — no opt-out footer appended on outbound send", async () => {
    // Hub bodies already include their own footer and are pre-capped; the
    // talk edge must transmit them verbatim (never double the footer).
    const hubBody = `Reminder: court 9am. ${OPT_OUT_FOOTER}`;
    let seen = "";
    _setSmsSenderForTests(async ({ body }) => {
      seen = body;
      return { sid: "SM_verbatim" };
    });
    await sendSms({ to: "+15551230123", body: hubBody, dedupeKey: "v1" });
    assert.equal(seen, hubBody, "body sent byte-for-byte");
    assert.equal(seen.split(OPT_OUT_FOOTER).length - 1, 1, "footer not doubled");
  });
});

describe("sendSms — suppression", () => {
  it("returns the 'suppressed' sentinel and does NOT call Twilio for an opted-out number", async () => {
    let calls = 0;
    _setSmsSenderForTests(async () => {
      calls++;
      return { sid: "SM_should_not_happen" };
    });
    await suppress("+15551230123");

    const r = await sendSms({
      to: "+15551230123",
      body: "hello",
      dedupeKey: "supp-1",
    });
    assert.equal(r.status, 200);
    if (r.ok) assert.equal(r.body.sid, "suppressed");
    assert.equal(calls, 0, "Twilio sender must not be invoked");
  });

  it("still sends to a number that is NOT suppressed", async () => {
    let calls = 0;
    _setSmsSenderForTests(async () => {
      calls++;
      return { sid: "SM_ok" };
    });
    await suppress("+15559998888"); // a different number

    const r = await sendSms({ to: "+15551230123", body: "hi", dedupeKey: "supp-2" });
    assert.equal(r.status, 200);
    if (r.ok) assert.equal(r.body.sid, "SM_ok");
    assert.equal(calls, 1);
  });
});

describe("sendSms — twilio failure", () => {
  it("returns 500 (uncached) when the Twilio send throws", async () => {
    _setSmsSenderForTests(async () => {
      throw new Error("twilio boom");
    });
    const r = await sendSms({ to: "+15551230123", body: "hi", dedupeKey: "k" });
    assert.equal(r.status, 500);

    // A transient 500 must NOT be cached — a retry on the same dedupeKey
    // should reach the sender again.
    let retried = false;
    _setSmsSenderForTests(async () => {
      retried = true;
      return { sid: "SM_retry" };
    });
    const r2 = await sendSms({ to: "+15551230123", body: "hi", dedupeKey: "k" });
    assert.equal(r2.status, 200);
    assert.equal(retried, true);
  });
});
