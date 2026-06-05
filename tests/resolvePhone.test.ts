/**
 * tests/resolvePhone.test.ts — Tests for the trusted resolve edge
 * client (talk → hub).
 *
 * `globalThis.fetch` is stubbed per-test and `env.hubBaseUrl` is toggled
 * so we can exercise every branch (200 / 404 / 500 / timeout / unset)
 * without a network. `env` is a plain object (`as const` is a
 * compile-time-only annotation), so mutating it at runtime is safe; we
 * restore it in afterEach. Test files run in separate processes, so the
 * toggle can't leak into the handler tests that also call this.
 */

import "./helpers/setupEnv.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { resolvePhoneToSubject } from "../src/core/resolvePhone.js";

const originalFetch = globalThis.fetch;
const HUB = "https://hub.example.com";

function setHub(url: string): void {
  (env as unknown as { hubBaseUrl: string }).hubBaseUrl = url;
}

describe("resolvePhoneToSubject", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    setHub("");
  });

  it("returns null WITHOUT fetching when HUB_BASE_URL is unset", async () => {
    setHub("");
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;

    assert.equal(await resolvePhoneToSubject("+15551234567"), null);
    assert.equal(called, false, "must not call the hub when unconfigured");
  });

  it("returns null WITHOUT fetching for an unknown caller number", async () => {
    setHub(HUB);
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;

    assert.equal(await resolvePhoneToSubject("unknown"), null);
    assert.equal(called, false);
  });

  it("returns the subject on 200 and sends the right request", async () => {
    setHub(HUB);
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ subject: "user_42" }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await resolvePhoneToSubject("+15551234567");
    assert.equal(r, "user_42");
    assert.equal(capturedUrl, `${HUB}/internal/v1/resolve-phone`);
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${env.outboundApiKey}`);
    assert.deepEqual(JSON.parse(capturedInit?.body as string), {
      phone: "+15551234567",
    });
  });

  it("returns null on 404 not_linked (anonymous fallback)", async () => {
    setHub(HUB);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "not_linked" }), {
        status: 404,
      })) as typeof fetch;

    assert.equal(await resolvePhoneToSubject("+15551234567"), null);
  });

  it("fails open to null on a 500", async () => {
    setHub(HUB);
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;

    assert.equal(await resolvePhoneToSubject("+15551234567"), null);
  });

  it("fails open to null on a network/timeout error", async () => {
    setHub(HUB);
    globalThis.fetch = (async () => {
      throw new Error("The operation was aborted");
    }) as typeof fetch;

    assert.equal(await resolvePhoneToSubject("+15551234567"), null);
  });

  it("returns null on a 200 that omits the subject field", async () => {
    setHub(HUB);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

    assert.equal(await resolvePhoneToSubject("+15551234567"), null);
  });
});
