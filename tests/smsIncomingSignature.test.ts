/**
 * tests/smsIncomingSignature.test.ts — /sms/incoming signature gate.
 *
 * setupEnvSig enables VALIDATE_TWILIO_SIGNATURE, so the handler verifies
 * the X-Twilio-Signature. A missing or forged signature must be rejected
 * with 403 BEFORE any suppression / hub work happens.
 */

import "./helpers/setupEnvSig.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import incomingSms from "../api/sms/incoming.js";
import { mockRequest, mockResponse } from "./helpers/mockHttp.js";
import { _setHubFetchForTests } from "../src/services/hub.js";

afterEach(() => _setHubFetchForTests(null));

function smsReq(headers: Record<string, string>) {
  return mockRequest({
    url: "/api/sms/incoming",
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    headers,
    body: new URLSearchParams({ From: "+15551230123", To: "+15559990000", Body: "STOP" }).toString(),
  });
}

describe("/sms/incoming — signature validation", () => {
  it("403s when the X-Twilio-Signature header is missing", async () => {
    let hubCalled = false;
    _setHubFetchForTests((async () => {
      hubCalled = true;
      return { status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch);

    const { res, getStatus } = mockResponse();
    await incomingSms(smsReq({}), res);
    assert.equal(getStatus(), 403);
    assert.equal(hubCalled, false, "must reject before any hub work");
  });

  it("403s when the signature is present but wrong", async () => {
    const { res, getStatus } = mockResponse();
    await incomingSms(smsReq({ "x-twilio-signature": "obviously-not-valid" }), res);
    assert.equal(getStatus(), 403);
  });
});
