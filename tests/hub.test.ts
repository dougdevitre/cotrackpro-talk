/**
 * tests/hub.test.ts — Talk → Hub client (resolve-phone, send-auth-link).
 *
 * Exercises the status→result mapping, the presented Bearer + request
 * shape, and the fail-open behavior on network/timeout, all against an
 * injected fetch stub so nothing touches the network.
 */

import "./helpers/setupEnvHub.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePhone,
  sendAuthLink,
  recordConsent,
  forwardInboundSms,
  _setHubFetchForTests,
} from "../src/services/hub.js";

type Captured = { url: string; init: RequestInit };

/** Build a fetch stub that returns the given status/body and records the
 *  request it was called with. */
function stubFetch(
  status: number,
  body: unknown,
  captured?: Captured[],
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    captured?.push({ url, init });
    return {
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => _setHubFetchForTests(null));

describe("resolvePhone", () => {
  it("maps 200 → linked with subject and presents the bearer + E.164 body", async () => {
    const captured: Captured[] = [];
    _setHubFetchForTests(stubFetch(200, { subject: "clerk:user_123" }, captured));

    const r = await resolvePhone("+15551230123");
    assert.deepEqual(r, { status: "linked", subject: "clerk:user_123" });

    assert.equal(captured.length, 1);
    const { url, init } = captured[0];
    assert.equal(url, "https://hub.test.example.com/internal/v1/resolve-phone");
    assert.equal(init.method, "POST");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-shared-bearer");
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(init.body as string), { phone: "+15551230123" });
  });

  it("maps 404 → not_linked", async () => {
    _setHubFetchForTests(stubFetch(404, { error: "not_linked" }));
    assert.deepEqual(await resolvePhone("+15551230123"), { status: "not_linked" });
  });

  it("maps 401 → unauthorized", async () => {
    _setHubFetchForTests(stubFetch(401, { error: "unauthorized" }));
    assert.deepEqual(await resolvePhone("+15551230123"), { status: "unauthorized" });
  });

  it("maps 503 → not_configured", async () => {
    _setHubFetchForTests(stubFetch(503, { error: "resolve_not_configured" }));
    assert.deepEqual(await resolvePhone("+15551230123"), { status: "not_configured" });
  });

  it("maps 400 → invalid", async () => {
    _setHubFetchForTests(stubFetch(400, { error: "missing_phone" }));
    assert.deepEqual(await resolvePhone("+1"), { status: "invalid" });
  });

  it("treats a 200 with no subject as an error (fail open)", async () => {
    _setHubFetchForTests(stubFetch(200, {}));
    const r = await resolvePhone("+15551230123");
    assert.equal(r.status, "error");
  });

  it("fails open on a network error", async () => {
    _setHubFetchForTests((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    const r = await resolvePhone("+15551230123");
    assert.deepEqual(r, { status: "error", reason: "network" });
  });

  it("fails open on a timeout (AbortError)", async () => {
    _setHubFetchForTests((async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch);
    const r = await resolvePhone("+15551230123");
    assert.deepEqual(r, { status: "error", reason: "timeout" });
  });
});

describe("sendAuthLink", () => {
  it("maps 200 → sent and hits the send-auth-link path", async () => {
    const captured: Captured[] = [];
    _setHubFetchForTests(stubFetch(200, { ok: true }, captured));
    assert.deepEqual(await sendAuthLink("+15551230123"), { status: "sent" });
    assert.equal(
      captured[0].url,
      "https://hub.test.example.com/internal/v1/send-auth-link",
    );
  });

  it("maps 429 → rate_limited", async () => {
    _setHubFetchForTests(stubFetch(429, { error: "rate_limited" }));
    assert.deepEqual(await sendAuthLink("+15551230123"), { status: "rate_limited" });
  });

  it("maps 503 sms_delivery_unavailable → sms_unavailable", async () => {
    _setHubFetchForTests(stubFetch(503, { error: "sms_delivery_unavailable" }));
    assert.deepEqual(await sendAuthLink("+15551230123"), {
      status: "sms_unavailable",
    });
  });

  it("maps 503 auth_link_not_configured → not_configured", async () => {
    _setHubFetchForTests(stubFetch(503, { error: "auth_link_not_configured" }));
    assert.deepEqual(await sendAuthLink("+15551230123"), {
      status: "not_configured",
    });
  });

  it("maps 400 → invalid and 401 → unauthorized", async () => {
    _setHubFetchForTests(stubFetch(400, { error: "invalid_phone" }));
    assert.deepEqual(await sendAuthLink("+1"), { status: "invalid" });
    _setHubFetchForTests(stubFetch(401, { error: "unauthorized" }));
    assert.deepEqual(await sendAuthLink("+15551230123"), { status: "unauthorized" });
  });
});

describe("recordConsent", () => {
  it("sends the consent under the `consent` key (NOT `state`)", async () => {
    const captured: Captured[] = [];
    _setHubFetchForTests(stubFetch(200, { ok: true, state: "opted_out" }, captured));

    const r = await recordConsent("+15551230123", "opted_out", "STOP");
    assert.deepEqual(r, { status: "ok" });

    const { url, init } = captured[0];
    assert.equal(url, "https://hub.test.example.com/internal/v1/record-consent");
    const sent = JSON.parse(init.body as string);
    assert.equal(sent.consent, "opted_out", "hub reads `consent`, not `state`");
    assert.equal(sent.state, undefined);
    assert.equal(sent.phone, "+15551230123");
  });

  it("maps 401 → unauthorized", async () => {
    _setHubFetchForTests(stubFetch(401, { error: "unauthorized" }));
    assert.deepEqual(await recordConsent("+15551230123", "opted_in"), {
      status: "unauthorized",
    });
  });
});

describe("forwardInboundSms", () => {
  it("sends { phone, keyword } (NOT { from, to, body, messageSid }) and returns the reply", async () => {
    const captured: Captured[] = [];
    _setHubFetchForTests(stubFetch(200, { reply: "Your next deadline is Friday." }, captured));

    const r = await forwardInboundSms({ phone: "+15551230123", keyword: "DEADLINES" });
    assert.deepEqual(r, { status: "ok", reply: "Your next deadline is Friday." });

    const { url, init } = captured[0];
    assert.equal(url, "https://hub.test.example.com/internal/v1/inbound-sms");
    assert.deepEqual(JSON.parse(init.body as string), {
      phone: "+15551230123",
      keyword: "DEADLINES",
    });
  });

  it("maps 404 → not_linked", async () => {
    _setHubFetchForTests(stubFetch(404, { error: "not_linked" }));
    assert.deepEqual(await forwardInboundSms({ phone: "+15551230123", keyword: "hi" }), {
      status: "not_linked",
    });
  });
});
