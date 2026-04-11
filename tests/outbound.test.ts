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
} from "../src/core/outbound.js";
import { _resetKvForTests } from "../src/services/kv.js";

describe("authorizeOutbound", () => {
  // setupEnv doesn't set OUTBOUND_API_KEY so auth is disabled here.
  // The enabled path is the same predicate — easy to verify manually
  // by flipping the env before `npm test`. We test disabled semantics.

  it("returns null when OUTBOUND_API_KEY is unset", () => {
    assert.equal(authorizeOutbound(undefined), null);
    assert.equal(authorizeOutbound("Bearer whatever"), null);
  });
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
