/**
 * tests/tts.test.ts — Tests for the sub-app TTS proxy.
 *
 * Scope:
 * - Unit tests for validateTtsRequest (input shape, caps, allow-lists).
 * - E2E "unauth" test through synthesizeTts to verify the auth gate.
 *
 * The happy-path E2E (authenticated user → ElevenLabs fetch → audio
 * bytes) is not covered here because stubbing Clerk's JWT verifier
 * through a static ESM import is fragile. That path is identical in
 * shape to /api/ai/complete and is exercised by integration tests.
 */

import "./helpers/setupEnv.js";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateTtsRequest, synthesizeTts } from "../src/core/tts.js";

describe("validateTtsRequest", () => {
  it("rejects undefined body", () => {
    const r = validateTtsRequest(undefined);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.status, 400);
  });

  it("rejects non-object body", () => {
    // @ts-expect-error — deliberately wrong shape
    const r = validateTtsRequest("a string");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.status, 400);
  });

  it("rejects missing text", () => {
    const r = validateTtsRequest({ voiceId: "EXAVITQu4vr4xnSDxMaL" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.status, 400);
  });

  it("rejects empty text", () => {
    const r = validateTtsRequest({ text: "" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.status, 400);
  });

  it("rejects non-string text", () => {
    const r = validateTtsRequest({ text: 123 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.status, 400);
  });

  it("rejects text over the per-request char cap (default 1500)", () => {
    const huge = "a".repeat(10_000);
    const r = validateTtsRequest({ text: huge });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.status, 413);
  });

  it("rejects malformed voiceId (path traversal)", () => {
    const r = validateTtsRequest({ text: "hi", voiceId: "../etc/passwd" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.status, 400);
  });

  it("rejects voiceId with non-alphanumeric chars", () => {
    const r = validateTtsRequest({ text: "hi", voiceId: "abc$%^" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.status, 400);
  });

  it("rejects voiceId too short", () => {
    const r = validateTtsRequest({ text: "hi", voiceId: "short" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.status, 400);
  });

  it("accepts valid text with default voice (caller omits voiceId)", () => {
    const r = validateTtsRequest({ text: "Hello, world." });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.voiceId.length >= 16);
      assert.equal(r.text, "Hello, world.");
      assert.ok(r.outputFormat.startsWith("mp3_"));
    }
  });

  it("accepts valid voiceId override", () => {
    const r = validateTtsRequest({
      text: "Hi",
      voiceId: "EXAVITQu4vr4xnSDxMaL",
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.voiceId, "EXAVITQu4vr4xnSDxMaL");
  });

  it("truncates overly long `app` identifiers to 64 chars", () => {
    const r = validateTtsRequest({
      text: "hi",
      app: "x".repeat(200),
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.app?.length, 64);
  });

  it("accepts text exactly at the char cap", () => {
    // Default TTS_MAX_CHARS_PER_REQUEST is 1500.
    const atCap = "a".repeat(1500);
    const r = validateTtsRequest({ text: atCap });
    assert.equal(r.ok, true);
  });
});

describe("synthesizeTts — auth gate", () => {
  it("returns 401 when Authorization header is missing (Clerk unset in tests)", async () => {
    // Setup leaves CLERK_PUBLISHABLE_KEY unset, so verifyClerkToken
    // short-circuits to authenticated=false. This asserts the proxy
    // fails closed when no/invalid auth is present.
    const result = await synthesizeTts(undefined, { text: "hi" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  it("returns 401 for a non-Bearer Authorization header", async () => {
    const result = await synthesizeTts("Basic abc123", { text: "hi" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });
});
