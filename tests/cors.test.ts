/**
 * tests/cors.test.ts — Tests for the sub-app CORS allow-list.
 *
 * Two separate origin families are allowed: *.cotrackpro.com (custom
 * domain) and cotrackpro-*.vercel.app (Vercel-hosted sub-apps). The
 * allow-list must cover both without opening up to arbitrary Vercel
 * tenants.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAllowedOrigin, corsHeaders } from "../src/core/cors.js";

describe("resolveAllowedOrigin", () => {
  it("returns null for undefined/empty origin", () => {
    assert.equal(resolveAllowedOrigin(undefined), null);
    assert.equal(resolveAllowedOrigin(""), null);
  });

  it("allows exact localhost + cotrackpro.com", () => {
    assert.equal(
      resolveAllowedOrigin("https://cotrackpro.com"),
      "https://cotrackpro.com",
    );
    assert.equal(
      resolveAllowedOrigin("http://localhost:3000"),
      "http://localhost:3000",
    );
    assert.equal(
      resolveAllowedOrigin("http://localhost:5173"),
      "http://localhost:5173",
    );
  });

  it("allows https://*.cotrackpro.com subdomains", () => {
    assert.equal(
      resolveAllowedOrigin("https://story.cotrackpro.com"),
      "https://story.cotrackpro.com",
    );
    assert.equal(
      resolveAllowedOrigin("https://legal.cotrackpro.com"),
      "https://legal.cotrackpro.com",
    );
  });

  it("allows https://cotrackpro-*.vercel.app (project canonical)", () => {
    assert.equal(
      resolveAllowedOrigin("https://cotrackpro-story.vercel.app"),
      "https://cotrackpro-story.vercel.app",
    );
    assert.equal(
      resolveAllowedOrigin("https://cotrackpro-legal-ethics.vercel.app"),
      "https://cotrackpro-legal-ethics.vercel.app",
    );
  });

  it("allows https://cotrackpro-*-<team>.vercel.app (deploy previews)", () => {
    assert.equal(
      resolveAllowedOrigin(
        "https://cotrackpro-story-abc123-dougdevitres-projects.vercel.app",
      ),
      "https://cotrackpro-story-abc123-dougdevitres-projects.vercel.app",
    );
  });

  it("rejects http:// Vercel origins (must be https)", () => {
    assert.equal(
      resolveAllowedOrigin("http://cotrackpro-story.vercel.app"),
      null,
    );
  });

  it("rejects non-cotrackpro vercel.app hostnames", () => {
    assert.equal(resolveAllowedOrigin("https://myapp.vercel.app"), null);
    assert.equal(resolveAllowedOrigin("https://evilapp.vercel.app"), null);
    // Name without the cotrackpro- prefix shouldn't pass even if it
    // contains the word somewhere.
    assert.equal(
      resolveAllowedOrigin("https://not-cotrackpro-evil.vercel.app"),
      null,
    );
  });

  it("rejects lookalike domains that don't end in vercel.app or cotrackpro.com", () => {
    assert.equal(
      resolveAllowedOrigin("https://cotrackpro-story.vercel.app.evil.com"),
      null,
    );
    assert.equal(
      resolveAllowedOrigin("https://cotrackpro-story.evil.com"),
      null,
    );
    assert.equal(
      resolveAllowedOrigin("https://evil-cotrackpro.com"),
      null,
    );
  });

  it("rejects malformed origins", () => {
    assert.equal(resolveAllowedOrigin("not a url"), null);
    assert.equal(resolveAllowedOrigin("javascript:alert(1)"), null);
  });
});

describe("corsHeaders", () => {
  it("returns {} for disallowed origin (preserves fail-closed default)", () => {
    assert.deepEqual(corsHeaders("https://evil.example.com"), {});
    assert.deepEqual(corsHeaders(undefined), {});
  });

  it("echoes the origin and sets credentials=true for a Vercel sub-app", () => {
    const h = corsHeaders("https://cotrackpro-story.vercel.app");
    assert.equal(h["Access-Control-Allow-Origin"], "https://cotrackpro-story.vercel.app");
    assert.equal(h["Access-Control-Allow-Credentials"], "true");
    assert.equal(h["Vary"], "Origin");
    assert.ok(h["Access-Control-Allow-Headers"].includes("Authorization"));
  });
});
