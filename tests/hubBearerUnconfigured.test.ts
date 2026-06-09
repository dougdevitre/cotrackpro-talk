/**
 * tests/hubBearerUnconfigured.test.ts — the "503 unconfigured" auth branch.
 *
 * setupEnvUnconfigured simulates a production deploy with the shared talk
 * bearer UNSET. Both hub→talk endpoints must fail CLOSED with 503 (service
 * unconfigured) rather than 401 — so the hub can tell "talk isn't wired up"
 * apart from "you sent the wrong token".
 */

import "./helpers/setupEnvUnconfigured.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authorizeHubBearer } from "../src/core/auth.js";
import { authorizeInboundSms } from "../src/core/sms.js";
import { authorizeVoiceOutbound } from "../src/core/voiceOutbound.js";

describe("authorizeHubBearer — unconfigured in production", () => {
  it("returns 503 when the shared key is unset, regardless of header", () => {
    assert.equal(authorizeHubBearer(undefined, "x")?.status, 503);
    assert.equal(authorizeHubBearer("Bearer anything", "x")?.status, 503);
  });

  it("/api/sms/send maps it to a 503 result", () => {
    const r = authorizeInboundSms(undefined);
    assert.equal(r?.status, 503);
  });

  it("/api/call/outbound maps it to a 503 result", () => {
    const r = authorizeVoiceOutbound(undefined);
    assert.equal(r?.status, 503);
  });
});
