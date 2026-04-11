/**
 * tests/requestId.test.ts — Tests for audit P-5: HTTP request ID
 * correlation helper.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateRequestId,
  resolveRequestId,
} from "../src/core/requestId.js";

describe("generateRequestId", () => {
  it("returns a 16-char lowercase hex string", () => {
    const id = generateRequestId();
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it("produces different IDs across calls", () => {
    // Not strictly deterministic but 2^64 collision probability is
    // negligible in a 1000-iteration loop.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateRequestId());
    }
    assert.equal(seen.size, 1000, "generateRequestId should be collision-free");
  });
});

describe("resolveRequestId", () => {
  it("generates a new ID when no header is present", () => {
    const id = resolveRequestId(undefined);
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it("honors a valid inbound x-request-id header", () => {
    const id = resolveRequestId("req-abc-123");
    assert.equal(id, "req-abc-123");
  });

  it("takes the first value when the header arrives as an array", () => {
    const id = resolveRequestId(["first-id", "second-id"]);
    assert.equal(id, "first-id");
  });

  it("generates a new ID when the inbound header is empty", () => {
    const id = resolveRequestId("");
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it("generates a new ID when the inbound header is > 128 chars", () => {
    // A malicious caller might pass a huge header to amplify log
    // volume. Cap at 128 and generate a fresh ID instead.
    const huge = "x".repeat(200);
    const id = resolveRequestId(huge);
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.notEqual(id, huge);
  });

  it("generates a new ID when the inbound header contains control chars", () => {
    // Log injection guard — control chars could smuggle structured
    // log markers. Reject and generate fresh.
    const evil = "id\nmsg=spoofed";
    const id = resolveRequestId(evil);
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.notEqual(id, evil);
  });

  it("generates a new ID when the inbound header contains non-ASCII", () => {
    const unicode = "req-🚀";
    const id = resolveRequestId(unicode);
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.notEqual(id, unicode);
  });

  it("accepts a 128-char boundary header", () => {
    const boundary = "a".repeat(128);
    const id = resolveRequestId(boundary);
    assert.equal(id, boundary);
  });

  it("accepts the full printable-ASCII range", () => {
    let all = "";
    for (let c = 0x20; c <= 0x7e; c++) all += String.fromCharCode(c);
    // 95 chars — within the 128 limit.
    const id = resolveRequestId(all);
    assert.equal(id, all);
  });
});
