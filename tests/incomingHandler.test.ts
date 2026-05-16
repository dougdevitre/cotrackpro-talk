/**
 * tests/incomingHandler.test.ts — End-to-end test of the Vercel
 * serverless `/call/incoming` handler.
 *
 * Earlier rounds covered the inbound voice-override path in pieces
 * (parser, TwiML builder, WS handler), but never the full HTTP
 * round-trip. This file fills that gap: it POSTs a form-encoded body
 * exactly the way Twilio does, runs it through the real handler, and
 * asserts on the returned TwiML.
 *
 * Twilio signature validation is off in the test env
 * (VALIDATE_TWILIO_SIGNATURE unset → defaults to "false"), so the
 * handler skips signature checks and we don't have to forge an
 * x-twilio-signature header.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import incomingHandler from "../api/call/incoming.js";
import { mockRequest, mockResponse } from "./helpers/mockHttp.js";

function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

describe("api/call/incoming — end-to-end", () => {
  it("405s non-POST requests", async () => {
    const req = mockRequest({ url: "/api/call/incoming", method: "GET" });
    const { res, getStatus } = mockResponse();
    await incomingHandler(req, res);
    assert.equal(getStatus(), 405);
  });

  it("falls back to ?role= and the role's default voice when To has no map entry", async () => {
    const req = mockRequest({
      url: "/api/call/incoming?role=attorney",
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({
        From: "+15551234567",
        To: "+15559999999", // not in INBOUND_PHONE_VOICE_MAP
        CallSid: "CA-incoming-1",
      }),
    });
    const { res, getStatus, getHeader, getBody } = mockResponse();
    await incomingHandler(req, res);

    assert.equal(getStatus(), 200);
    assert.match(getHeader("content-type") ?? "", /text\/xml/);
    const xml = getBody();
    // role passed through from query param
    assert.match(xml, /<Parameter name="role" value="attorney"/);
    // caller's number escaped + present
    assert.match(xml, /<Parameter name="callerNumber" value="\+15551234567"/);
    // no override → no voiceId stream param
    assert.ok(!xml.includes('name="voiceId"'));
  });

  it("applies the INBOUND_PHONE_VOICE_MAP override for a matching To number", async () => {
    const req = mockRequest({
      url: "/api/call/incoming",
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({
        From: "+15551234567",
        To: "+13143948500", // matches the test fixture in setupEnv.ts
        CallSid: "CA-incoming-2",
      }),
    });
    const { res, getStatus, getBody } = mockResponse();
    await incomingHandler(req, res);

    assert.equal(getStatus(), 200);
    const xml = getBody();
    assert.match(xml, /<Parameter name="role" value="parent"/);
    assert.match(xml, /<Parameter name="voiceId" value="2ydcbtd5sJZRYFMNgMVZ"/);
  });

  it("override beats ?role= query param", async () => {
    // Query says attorney but the phone map says parent → map wins.
    const req = mockRequest({
      url: "/api/call/incoming?role=attorney",
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({
        From: "+15551234567",
        To: "+13143948500",
        CallSid: "CA-incoming-3",
      }),
    });
    const { res, getBody } = mockResponse();
    await incomingHandler(req, res);

    const xml = getBody();
    assert.match(xml, /<Parameter name="role" value="parent"/);
    assert.ok(!xml.includes('value="attorney"'));
  });

  it("tolerates phone-number formatting differences in the To param", async () => {
    // Twilio normally sends E.164 with leading +, but defensively the
    // parser normalizes whitespace / parens. This test pins that
    // tolerance so a config-side typo doesn't silently break the
    // mapping.
    const req = mockRequest({
      url: "/api/call/incoming",
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({
        From: "+15551234567",
        To: "13143948500",  // missing leading +
        CallSid: "CA-incoming-4",
      }),
    });
    const { res, getBody } = mockResponse();
    await incomingHandler(req, res);

    const xml = getBody();
    assert.match(xml, /<Parameter name="voiceId" value="2ydcbtd5sJZRYFMNgMVZ"/);
  });
});
