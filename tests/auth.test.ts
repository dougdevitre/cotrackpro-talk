/**
 * tests/auth.test.ts — Tests for the timing-safe Bearer matcher.
 * Covers C-2 from the code review.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bearerMatches } from "../src/core/auth.js";

describe("bearerMatches", () => {
  it("returns true for a correctly-formatted matching token", () => {
    assert.equal(bearerMatches("Bearer abc123", "abc123"), true);
  });

  it("returns false for an undefined Authorization header", () => {
    assert.equal(bearerMatches(undefined, "abc123"), false);
  });

  it("returns false for an empty Authorization header", () => {
    assert.equal(bearerMatches("", "abc123"), false);
  });

  it("returns false when the token mismatches", () => {
    assert.equal(bearerMatches("Bearer wrong", "right"), false);
  });

  it("returns false for a missing 'Bearer ' prefix", () => {
    assert.equal(bearerMatches("abc123", "abc123"), false);
  });

  it("is case-sensitive on the Bearer prefix (RFC 6750 is case-insensitive, but we enforce case for strictness)", () => {
    // RFC 6750 says the scheme is case-insensitive, but clients
    // almost universally use "Bearer". Enforcing case makes the
    // check slightly stricter; document via test that this is the
    // chosen behavior.
    assert.equal(bearerMatches("bearer abc123", "abc123"), false);
    assert.equal(bearerMatches("BEARER abc123", "abc123"), false);
  });

  it("returns false for a token of the wrong length (would throw in timingSafeEqual if not length-guarded)", () => {
    // Length mismatch causes crypto.timingSafeEqual to throw. Our
    // helper catches this via an explicit length check so callers
    // get a clean false instead of a crash.
    assert.equal(bearerMatches("Bearer short", "longer-token"), false);
    assert.equal(bearerMatches("Bearer longer-token", "short"), false);
  });

  it("tolerates unicode tokens of matching lengths", () => {
    // Tokens are usually ASCII but the helper must not throw on
    // UTF-8 multibyte characters.
    const t = "tøken-🔑";
    assert.equal(bearerMatches(`Bearer ${t}`, t), true);
  });

  it("does not match 'Bearer ' followed by whitespace", () => {
    // Defense against a malformed header passing through.
    assert.equal(bearerMatches("Bearer  abc", "abc"), false);
  });
});
