/**
 * tests/sms.test.ts — Tests for the SMS (OTP) delivery core.
 *
 * The Twilio REST call is exercised through the `_setSmsSenderForTests`
 * DI seam so the happy path and the idempotent-replay path can be
 * asserted without touching the network. Auth is covered by
 * tests/auth.test.ts (the shared bearerMatches helper that
 * authorizeOutbound delegates to); here we focus on validation,
 * idempotency, and rate limiting.
 */

import "./helpers/setupEnv.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  sendSms,
  checkSmsRateLimit,
  _setSmsSenderForTests,
  type SmsSender,
} from "../src/core/sms.js";
import { env } from "../src/config/env.js";
import {
  _resetKvForTests,
  _setKvForTests,
  _MemoryKvForTests as MemoryKv,
} from "../src/services/kv.js";
import { _resetPhoneValidationCacheForTests } from "../src/core/phoneValidation.js";

/** A sender that records every call and returns a fixed sid. */
function recordingSender(): { sender: SmsSender; calls: Array<{ to: string; from: string; body: string }> } {
  const calls: Array<{ to: string; from: string; body: string }> = [];
  const sender: SmsSender = async (args) => {
    calls.push(args);
    return { sid: "SM_fake_123" };
  };
  return { sender, calls };
}

describe("sendSms — validation", () => {
  beforeEach(() => {
    _resetPhoneValidationCacheForTests();
    _resetKvForTests();
    _setKvForTests(new MemoryKv());
    _setSmsSenderForTests(null);
  });
  afterEach(() => {
    _resetKvForTests();
    _setSmsSenderForTests(null);
  });

  it("returns 400 on missing 'to'", async () => {
    const r = await sendSms({ body: "hi" });
    assert.equal(r.status, 400);
    if (!r.ok) assert.match(r.body.error, /Missing 'to'/);
  });

  it("returns 400 on a non-E.164 'to'", async () => {
    const r = await sendSms({ to: "5551234567", body: "hi" });
    assert.equal(r.status, 400);
    if (!r.ok) assert.match(r.body.error, /Invalid destination/);
  });

  it("returns 400 on a disallowed country (default US/CA)", async () => {
    const r = await sendSms({ to: "+442071234567", body: "hi" });
    assert.equal(r.status, 400);
    if (!r.ok) assert.match(r.body.details ?? "", /GB/);
  });

  it("returns 400 on a missing message body", async () => {
    const r = await sendSms({ to: "+15551234567" });
    assert.equal(r.status, 400);
    if (!r.ok) assert.match(r.body.error, /message body/);
  });

  it("returns 400 on a whitespace-only message body", async () => {
    const r = await sendSms({ to: "+15551234567", body: "   " });
    assert.equal(r.status, 400);
  });
});

describe("sendSms — happy path", () => {
  beforeEach(() => {
    _resetPhoneValidationCacheForTests();
    _resetKvForTests();
    _setKvForTests(new MemoryKv());
  });
  afterEach(() => {
    _resetKvForTests();
    _setSmsSenderForTests(null);
  });

  it("sends via the injected sender and returns the sid", async () => {
    const { sender, calls } = recordingSender();
    _setSmsSenderForTests(sender);

    const r = await sendSms({
      to: "+15551234567",
      body: "Your code is 123456",
      dedupeKey: "d1",
    });

    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    if (r.ok) {
      assert.equal(r.body.sid, "SM_fake_123");
      assert.equal(r.body.to, "+15551234567");
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.body, "Your code is 123456");
    // Sends from the configured Twilio number.
    assert.equal(calls[0]?.from, "+15551234567");
  });
});

describe("sendSms — idempotency via dedupeKey", () => {
  beforeEach(() => {
    _resetPhoneValidationCacheForTests();
    _resetKvForTests();
    _setKvForTests(new MemoryKv());
  });
  afterEach(() => {
    _resetKvForTests();
    _setSmsSenderForTests(null);
  });

  it("a repeated dedupeKey replays the cached result without a second send", async () => {
    const { sender, calls } = recordingSender();
    _setSmsSenderForTests(sender);

    const first = await sendSms({ to: "+15551234567", body: "code 1", dedupeKey: "dup" });
    assert.equal(first.ok, true);
    assert.equal(first.headers?.["X-Idempotent-Replay"], "false");

    const second = await sendSms({ to: "+15551234567", body: "code 1", dedupeKey: "dup" });
    assert.equal(second.ok, true);
    assert.equal(second.headers?.["X-Idempotent-Replay"], "true");
    if (second.ok) assert.equal(second.body.sid, "SM_fake_123");

    // Crucially: Twilio was hit exactly once.
    assert.equal(calls.length, 1, "replay must NOT trigger a second send");
  });

  it("different dedupeKeys are isolated (both send)", async () => {
    const { sender, calls } = recordingSender();
    _setSmsSenderForTests(sender);

    await sendSms({ to: "+15551234567", body: "a", dedupeKey: "k1" });
    const second = await sendSms({ to: "+15551234567", body: "b", dedupeKey: "k2" });
    assert.equal(second.headers?.["X-Idempotent-Replay"], "false");
    assert.equal(calls.length, 2);
  });

  it("without a dedupeKey, repeats are not marked as replays and each sends", async () => {
    const { sender, calls } = recordingSender();
    _setSmsSenderForTests(sender);

    const r1 = await sendSms({ to: "+15551234567", body: "x" });
    const r2 = await sendSms({ to: "+15551234567", body: "x" });
    assert.equal(r1.headers?.["X-Idempotent-Replay"], undefined);
    assert.equal(r2.headers?.["X-Idempotent-Replay"], undefined);
    assert.equal(calls.length, 2);
  });

  it("rejects a malformed dedupeKey with 400", async () => {
    const r = await sendSms({ to: "+15551234567", body: "x", dedupeKey: "k\tbad" });
    assert.equal(r.status, 400);
    if (!r.ok) assert.match(r.body.error, /Invalid Idempotency-Key/);
  });

  it("does NOT cache transient send failures (500 stays retryable)", async () => {
    let attempts = 0;
    const flaky: SmsSender = async () => {
      attempts += 1;
      throw new Error("twilio boom");
    };
    _setSmsSenderForTests(flaky);

    const r1 = await sendSms({ to: "+15551234567", body: "x", dedupeKey: "retry-me" });
    assert.equal(r1.status, 500);

    // A second attempt with the same key must re-run (not replay the 500).
    const r2 = await sendSms({ to: "+15551234567", body: "x", dedupeKey: "retry-me" });
    assert.equal(r2.status, 500);
    assert.equal(attempts, 2, "the 500 must not be cached");
  });
});

describe("checkSmsRateLimit", () => {
  beforeEach(() => {
    _resetKvForTests();
    _setKvForTests(new MemoryKv());
  });
  afterEach(() => {
    _resetKvForTests();
  });

  it("allows the first request when within limits", async () => {
    const r = await checkSmsRateLimit("Bearer test-key");
    assert.equal(r, null);
  });

  it("trips to 429 once the per-minute budget is exhausted", async () => {
    // setupEnv sets SMS_RATE_LIMIT_PER_MIN high; flood just past it.
    const limit = env.smsRateLimitPerMin;
    let tripped: Awaited<ReturnType<typeof checkSmsRateLimit>> = null;
    for (let i = 0; i < limit + 1; i++) {
      tripped = await checkSmsRateLimit("Bearer flood-key");
      if (tripped) break;
    }
    assert.ok(tripped, "should have tripped the limit");
    if (tripped) {
      assert.equal(tripped.status, 429);
      assert.ok(tripped.headers["Retry-After"]);
      if (!tripped.ok) assert.ok(tripped.body.retryAfterSeconds > 0);
    }
  });
});
