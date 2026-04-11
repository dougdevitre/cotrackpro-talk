/**
 * tests/outbound.test.ts — Tests for outbound-call auth + rate-limit
 * helpers.
 *
 * The Twilio REST call in initiateOutboundCall() is not tested here
 * because it would require mocking the twilio client singleton.
 * That's left to integration tests.
 */

import "./helpers/setupEnv.js";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeOutbound,
  checkOutboundRateLimit,
  initiateOutboundCall,
} from "../src/core/outbound.js";
import { _resetKvForTests } from "../src/services/kv.js";
import { _resetPhoneValidationCacheForTests } from "../src/core/phoneValidation.js";

describe("authorizeOutbound", () => {
  // setupEnv doesn't set OUTBOUND_API_KEY so auth is disabled here.
  // The enabled path is exercised by tests/auth.test.ts (the shared
  // bearerMatches helper) — since both authorizeOutbound and
  // authorizeRecords now delegate to it, one set of tests covers both.

  it("returns null when OUTBOUND_API_KEY is unset", () => {
    assert.equal(authorizeOutbound(undefined), null);
    assert.equal(authorizeOutbound("Bearer whatever"), null);
  });
});

describe("initiateOutboundCall — input validation (C-1)", () => {
  // These tests exercise the validation that runs BEFORE the Twilio
  // REST call, so we never hit the network. Any test that reaches
  // twilioClient.calls.create would fail because there's no mock.

  beforeEach(() => {
    _resetPhoneValidationCacheForTests();
  });

  it("returns 400 on missing 'to'", async () => {
    const r = await initiateOutboundCall({});
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.body.error, /Missing 'to'/);
    }
  });

  it("returns 400 on a non-E.164 phone number", async () => {
    const r = await initiateOutboundCall({ to: "15551234567" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.body.error, /Invalid destination/);
      assert.match(r.body.details ?? "", /E\.164/);
    }
  });

  it("returns 400 on a number from a disallowed country (default US/CA)", async () => {
    const r = await initiateOutboundCall({ to: "+442071234567" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.body.details ?? "", /GB/);
    }
  });

  it("returns 400 on premium-rate international prefixes", async () => {
    // UAE premium rate scenario — this is exactly the bill-fraud
    // surface the fix closes.
    const r = await initiateOutboundCall({ to: "+971501234567" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  // Note: we do NOT test the success path here because it would make
  // a real Twilio REST API call. The phone-number validation IS
  // tested in tests/phoneValidation.test.ts and the Twilio call
  // itself is left for integration tests.
});

describe("checkOutboundRateLimit", () => {
  beforeEach(() => {
    _resetKvForTests();
  });

  afterEach(() => {
    mock.timers.reset();
    _resetKvForTests();
  });

  it("allows the first request when within limits", async () => {
    // setupEnv sets OUTBOUND_RATE_LIMIT_PER_MIN=1000 /HOUR=10000
    const r = await checkOutboundRateLimit("Bearer test-key");
    assert.equal(r, null, "should return null to signal 'allowed'");
  });

  it("allows repeated requests under the limit", async () => {
    for (let i = 0; i < 50; i++) {
      const r = await checkOutboundRateLimit("Bearer test-key");
      assert.equal(r, null);
    }
  });

  it("keys different Authorization headers to different buckets", async () => {
    // Burn a few on one client, confirm the other is unaffected.
    for (let i = 0; i < 10; i++) {
      await checkOutboundRateLimit("Bearer alice-key");
    }

    const bob = await checkOutboundRateLimit("Bearer bob-key");
    assert.equal(bob, null, "bob should still be allowed");
  });

  it("treats missing Authorization as 'anonymous' bucket", async () => {
    // setupEnv doesn't set OUTBOUND_API_KEY, so the code path uses
    // the literal "anonymous" key. Just confirm it doesn't throw.
    const r = await checkOutboundRateLimit(undefined);
    assert.equal(r, null);
  });
});
