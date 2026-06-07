/**
 * tests/inboundCallerResolve.test.ts — Inbound caller recognition wiring.
 *
 * Covers resolveInboundCaller (resolve-phone → optional send-auth-link,
 * fail-open) and the new subject/authNotice TwiML <Parameter>s, against
 * an injected hub fetch stub.
 */

import "./helpers/setupEnvHub.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveInboundCaller,
  buildIncomingTwiml,
  AUTH_LINK_NOTICE,
} from "../src/core/twiml.js";
import { _setHubFetchForTests } from "../src/services/hub.js";

/** Route a fetch by URL suffix to a {status, body}. */
function routeFetch(
  routes: Record<string, { status: number; body: unknown }>,
  captured?: string[],
): typeof fetch {
  return (async (url: string) => {
    captured?.push(url);
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key) throw new Error(`no route for ${url}`);
    const { status, body } = routes[key];
    return { status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => _setHubFetchForTests(null));

describe("resolveInboundCaller", () => {
  it("returns subject for a linked caller and never sends an auth link", async () => {
    const captured: string[] = [];
    _setHubFetchForTests(
      routeFetch(
        { "/resolve-phone": { status: 200, body: { subject: "clerk:u1" } } },
        captured,
      ),
    );
    const r = await resolveInboundCaller("+15551230123");
    assert.deepEqual(r, { subject: "clerk:u1" });
    assert.equal(captured.length, 1); // resolve only, no send-auth-link
  });

  it("texts an unlinked caller a link and returns the spoken notice", async () => {
    _setHubFetchForTests(
      routeFetch({
        "/resolve-phone": { status: 404, body: { error: "not_linked" } },
        "/send-auth-link": { status: 200, body: { ok: true } },
      }),
    );
    const r = await resolveInboundCaller("+15551230123");
    assert.deepEqual(r, { authNotice: AUTH_LINK_NOTICE });
  });

  it("fails open (anonymous) when the auth link is rate-limited", async () => {
    _setHubFetchForTests(
      routeFetch({
        "/resolve-phone": { status: 404, body: { error: "not_linked" } },
        "/send-auth-link": { status: 429, body: { error: "rate_limited" } },
      }),
    );
    assert.deepEqual(await resolveInboundCaller("+15551230123"), {});
  });

  it("fails open when resolve-phone errors", async () => {
    _setHubFetchForTests((async () => {
      throw new Error("down");
    }) as unknown as typeof fetch);
    assert.deepEqual(await resolveInboundCaller("+15551230123"), {});
  });

  it("skips the hub entirely for an unknown caller id", async () => {
    let called = false;
    _setHubFetchForTests((async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch);
    assert.deepEqual(await resolveInboundCaller("unknown"), {});
    assert.deepEqual(await resolveInboundCaller(undefined), {});
    assert.equal(called, false);
  });
});

describe("buildIncomingTwiml — subject + authNotice params", () => {
  it("includes subject and authNotice when provided", () => {
    const xml = buildIncomingTwiml({
      role: "parent",
      callerNumber: "+15551230123",
      subject: "clerk:u1",
      authNotice: "check your phone",
    });
    assert.match(xml, /<Parameter name="subject" value="clerk:u1"/);
    assert.match(xml, /<Parameter name="authNotice" value="check your phone"/);
  });

  it("omits both when not provided", () => {
    const xml = buildIncomingTwiml({
      role: "parent",
      callerNumber: "+15551230123",
    });
    assert.ok(!xml.includes('name="subject"'));
    assert.ok(!xml.includes('name="authNotice"'));
  });
});
