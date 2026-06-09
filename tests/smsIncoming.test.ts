/**
 * tests/smsIncoming.test.ts — End-to-end test of the /sms/incoming
 * Twilio webhook handler.
 *
 * Signature validation is OFF in the test env (VALIDATE_TWILIO_SIGNATURE
 * unset → "false", NODE_ENV != production), so we don't forge an
 * x-twilio-signature here — that rejection path is covered in
 * tests/smsIncomingSignature.test.ts. The hub fetch is stubbed so the
 * forward path never hits the network.
 */

import "./helpers/setupEnvHub.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import incomingSms from "../api/sms/incoming.js";
import { mockRequest, mockResponse } from "./helpers/mockHttp.js";
import {
  _resetKvForTests,
  _setKvForTests,
  _MemoryKvForTests as MemoryKv,
} from "../src/services/kv.js";
import { isSuppressed, suppress, OPT_OUT_FOOTER } from "../src/core/consent.js";
import { _setHubFetchForTests } from "../src/services/hub.js";

type Captured = { url: string; init: RequestInit };

function stubFetch(status: number, body: unknown, captured?: Captured[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    captured?.push({ url, init });
    return { status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

function smsReq(params: Record<string, string>) {
  return mockRequest({
    url: "/api/sms/incoming",
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams(params).toString(),
  });
}

beforeEach(() => _setKvForTests(new MemoryKv()));
afterEach(() => {
  _setHubFetchForTests(null);
  _resetKvForTests();
});

describe("/sms/incoming — STOP", () => {
  it("suppresses the number, records consent=opted_out, and replies", async () => {
    const captured: Captured[] = [];
    _setHubFetchForTests(stubFetch(200, {}, captured));

    const req = smsReq({ From: "+15551230123", To: "+15559990000", Body: "STOP", MessageSid: "SM1" });
    const { res, getStatus, getBody } = mockResponse();
    await incomingSms(req, res);

    assert.equal(getStatus(), 200);
    assert.equal(await isSuppressed("+15551230123"), true);

    // record-consent called with opted_out.
    const consentCall = captured.find((c) => c.url.endsWith("/internal/v1/record-consent"));
    assert.ok(consentCall, "record-consent should be called");
    assert.equal(JSON.parse(consentCall!.init.body as string).state, "opted_out");

    // Reply is a TwiML <Message>.
    assert.match(getBody(), /<Message>/);
  });
});

describe("/sms/incoming — START", () => {
  it("unsuppresses the number and records consent=opted_in", async () => {
    const captured: Captured[] = [];
    _setHubFetchForTests(stubFetch(200, {}, captured));
    await suppress("+15551230123");

    const req = smsReq({ From: "+15551230123", To: "+15559990000", Body: "START" });
    const { res, getStatus } = mockResponse();
    await incomingSms(req, res);

    assert.equal(getStatus(), 200);
    assert.equal(await isSuppressed("+15551230123"), false);
    const consentCall = captured.find((c) => c.url.endsWith("/internal/v1/record-consent"));
    assert.ok(consentCall);
    assert.equal(JSON.parse(consentCall!.init.body as string).state, "opted_in");
  });
});

describe("/sms/incoming — Twilio Advanced Opt-Out (OptOutType)", () => {
  it("STOP via OptOutType: syncs suppression + consent, sends NO reply (Twilio already did)", async () => {
    const captured: Captured[] = [];
    _setHubFetchForTests(stubFetch(200, {}, captured));

    const req = smsReq({
      From: "+15551230123",
      To: "+15559990000",
      Body: "STOP",
      OptOutType: "STOP",
    });
    const { res, getStatus, getBody } = mockResponse();
    await incomingSms(req, res);

    assert.equal(getStatus(), 200);
    assert.equal(await isSuppressed("+15551230123"), true);
    const consent = captured.find((c) => c.url.endsWith("/internal/v1/record-consent"));
    assert.ok(consent);
    assert.equal(JSON.parse(consent!.init.body as string).state, "opted_out");
    // Twilio already replied → we must NOT send a second <Message>.
    assert.doesNotMatch(getBody(), /<Message>/);
  });

  it("START via OptOutType: unsuppresses + opted_in, no reply", async () => {
    const captured: Captured[] = [];
    _setHubFetchForTests(stubFetch(200, {}, captured));
    await suppress("+15551230123");

    const req = smsReq({
      From: "+15551230123",
      To: "+15559990000",
      Body: "START",
      OptOutType: "START",
    });
    const { res, getStatus, getBody } = mockResponse();
    await incomingSms(req, res);

    assert.equal(getStatus(), 200);
    assert.equal(await isSuppressed("+15551230123"), false);
    assert.doesNotMatch(getBody(), /<Message>/);
  });
});

describe("/sms/incoming — HELP", () => {
  it("replies statically WITHOUT calling the hub", async () => {
    const captured: Captured[] = [];
    _setHubFetchForTests(stubFetch(200, {}, captured));

    const req = smsReq({ From: "+15551230123", To: "+15559990000", Body: "HELP" });
    const { res, getStatus, getBody } = mockResponse();
    await incomingSms(req, res);

    assert.equal(getStatus(), 200);
    assert.match(getBody(), /<Message>/);
    assert.equal(captured.length, 0, "hub must not be called for HELP");
  });
});

describe("/sms/incoming — non-keyword forward", () => {
  it("forwards to the hub and relays its reply with exactly one footer", async () => {
    const captured: Captured[] = [];
    _setHubFetchForTests(stubFetch(200, { reply: "Thanks — rescheduled to 2pm." }, captured));

    const req = smsReq({
      From: "+15551230123",
      To: "+15559990000",
      Body: "Can we move to the afternoon?",
      MessageSid: "SM9",
    });
    const { res, getStatus, getBody } = mockResponse();
    await incomingSms(req, res);

    assert.equal(getStatus(), 200);
    const fwd = captured.find((c) => c.url.endsWith("/internal/v1/inbound-sms"));
    assert.ok(fwd, "inbound-sms should be called");

    const xml = getBody();
    assert.match(xml, /Thanks — rescheduled to 2pm\./);
    assert.equal(xml.split(OPT_OUT_FOOTER).length - 1, 1, "exactly one footer");
  });

  it("forwards a bare 'Yes' to the hub (not treated as opt-in)", async () => {
    const captured: Captured[] = [];
    _setHubFetchForTests(stubFetch(200, { reply: "Got it." }, captured));

    const req = smsReq({ From: "+15551230123", To: "+15559990000", Body: "Yes" });
    const { res, getStatus } = mockResponse();
    await incomingSms(req, res);

    assert.equal(getStatus(), 200);
    assert.ok(
      captured.find((c) => c.url.endsWith("/internal/v1/inbound-sms")),
      "a conversational 'Yes' must be forwarded, not consumed as START",
    );
    assert.equal(await isSuppressed("+15551230123"), false);
  });

  it("returns empty TwiML when the hub has no reply", async () => {
    _setHubFetchForTests(stubFetch(200, {}));
    const req = smsReq({ From: "+15551230123", To: "+15559990000", Body: "hello there" });
    const { res, getStatus, getBody } = mockResponse();
    await incomingSms(req, res);
    assert.equal(getStatus(), 200);
    assert.doesNotMatch(getBody(), /<Message>/);
  });
});
