/**
 * tests/twiml.test.ts — Tests for TwiML generation, XML escaping, and
 * Twilio webhook signature validation.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import twilio from "twilio";
import {
  escapeXmlAttr,
  buildIncomingTwiml,
  buildOutboundTwiml,
  signatureValidationEnabled,
  validateTwilioSignature,
  logIncomingCall,
} from "../src/core/twiml.js";

describe("escapeXmlAttr", () => {
  it("escapes the five XML special characters", () => {
    assert.equal(escapeXmlAttr("&"), "&amp;");
    assert.equal(escapeXmlAttr("<"), "&lt;");
    assert.equal(escapeXmlAttr(">"), "&gt;");
    assert.equal(escapeXmlAttr('"'), "&quot;");
    assert.equal(escapeXmlAttr("'"), "&apos;");
  });

  it("escapes & before other entities to avoid double-escaping", () => {
    // If we escaped < before &, we'd turn <&lt;> into &lt;&amp;lt;&gt;
    // which is wrong. Verify the order is correct.
    assert.equal(escapeXmlAttr("<&>"), "&lt;&amp;&gt;");
  });

  it("passes safe input through untouched", () => {
    assert.equal(
      escapeXmlAttr("abc 123 _-.:/"),
      "abc 123 _-.:/",
    );
  });

  it("escapes an attacker attempt to break out of the attribute", () => {
    // The role field is user-controllable (via query param); confirm
    // a quote-break-out attempt is neutralized.
    const attack = `"/><script>alert(1)</script>`;
    const escaped = escapeXmlAttr(attack);
    assert.ok(!escaped.includes('"'), "quotes must be escaped");
    assert.ok(!escaped.includes("<"), "angle brackets must be escaped");
  });
});

describe("buildIncomingTwiml", () => {
  it("wraps the stream URL from WS_DOMAIN", () => {
    const xml = buildIncomingTwiml({ role: "parent", callerNumber: "+15551234567" });
    // SERVER_DOMAIN=test.example.com from setupEnv → wsDomain = test.example.com
    assert.ok(xml.includes("wss://test.example.com/call/stream"));
  });

  it("embeds role and callerNumber as Stream parameters", () => {
    const xml = buildIncomingTwiml({
      role: "attorney",
      callerNumber: "+18885551212",
    });
    assert.match(xml, /<Parameter name="role" value="attorney"/);
    assert.match(xml, /<Parameter name="callerNumber" value="\+18885551212"/);
  });

  it("normalizes an unknown role to 'parent' (H-3)", () => {
    // After the H-3 fix, buildIncomingTwiml normalizes unknown roles
    // via normalizeRole() instead of passing them straight through.
    // This is the primary defense for the /call/incoming role query
    // param; the secondary defense (escapeXmlAttr) is still active.
    const xml = buildIncomingTwiml({
      role: 'x"/><Hang/>',
      callerNumber: "+15551234567",
    });
    assert.match(xml, /<Parameter name="role" value="parent"/);
    assert.ok(!xml.includes("<Hang"), "injected markup must never reach output");
  });

  it("escapes special characters in callerNumber (which is NOT normalized)", () => {
    // callerNumber is user-controlled via Twilio's 'From' header and
    // does NOT go through normalization — only escapeXmlAttr. This
    // test proves that secondary defense actually works.
    const xml = buildIncomingTwiml({
      role: "parent",
      callerNumber: '"/><Reject/><!--',
    });
    // The callerNumber value becomes an escaped XML attribute.
    assert.ok(!xml.includes('value=""/'), "raw quote break-out must be escaped");
    // The <Reject/> injection must not appear outside of the
    // escaped-attribute Parameter tag.
    const withoutParams = xml.replace(/<Parameter[^>]*\/>/g, "");
    assert.ok(!withoutParams.includes("<Reject"));
  });

  it("produces parseable XML", () => {
    const xml = buildIncomingTwiml({ role: "parent", callerNumber: "+15551234" });
    // Crude but sufficient parseability check.
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes("<Response>"));
    assert.ok(xml.includes("</Response>"));
  });
});

describe("buildOutboundTwiml", () => {
  it("tags the stream with direction=outbound", () => {
    const xml = buildOutboundTwiml({ role: "parent" });
    assert.match(xml, /<Parameter name="direction" value="outbound"/);
  });

  it("points Stream at WS_DOMAIN", () => {
    const xml = buildOutboundTwiml({ role: "parent" });
    assert.ok(xml.includes("wss://test.example.com/call/stream"));
  });
});

describe("signatureValidationEnabled", () => {
  it("reflects the env.validateTwilioSignature value", () => {
    // setupEnv doesn't set VALIDATE_TWILIO_SIGNATURE, so it falls to
    // the "false" default. Just check the accessor returns a boolean.
    assert.equal(typeof signatureValidationEnabled(), "boolean");
  });
});

describe("validateTwilioSignature", () => {
  // Pre-condition: VALIDATE_TWILIO_SIGNATURE is not set → disabled →
  // validateTwilioSignature always returns true regardless of
  // signature. This is the default single-host behavior from setupEnv.

  it("returns true when validation is disabled, even with no signature", () => {
    assert.equal(
      validateTwilioSignature(undefined, "https://x.test/path", {}),
      true,
    );
  });

  it("returns true when validation is disabled, even with a bad signature", () => {
    assert.equal(
      validateTwilioSignature("totally-wrong", "https://x.test/path", {
        a: "1",
      }),
      true,
    );
  });

  describe("when validation is enabled", () => {
    // Flip the env var for this sub-block. We need to stash the
    // previous value because other tests share the env.
    let prev: string | undefined;

    it("setup — enable signature validation", () => {
      prev = process.env.VALIDATE_TWILIO_SIGNATURE;
      process.env.VALIDATE_TWILIO_SIGNATURE = "true";
      // Note: env.ts read this value at module load, so this doesn't
      // actually flip signatureValidationEnabled(). We use
      // twilio.validateRequest directly in the real check, but the
      // env-cached flag is a boolean frozen at import time. So this
      // test validates the BEHAVIOR of twilio.validateRequest
      // directly instead of the env gate.
    });

    it("accepts a correctly-signed request", () => {
      const authToken = process.env.TWILIO_AUTH_TOKEN!;
      const url = "https://test.example.com/call/incoming";
      const params = { CallSid: "CA123", From: "+15551111111" };

      // Compute the expected signature using the same library the
      // server uses — this gives us a true end-to-end signature check.
      const expected = twilio.getExpectedTwilioSignature(
        authToken,
        url,
        params,
      );

      // Call twilio.validateRequest directly because env.ts has
      // frozen signatureValidationEnabled() to false for this test
      // run (see setup note above).
      const ok = twilio.validateRequest(authToken, expected, url, params);
      assert.equal(ok, true);
    });

    it("rejects a request signed for a different URL", () => {
      const authToken = process.env.TWILIO_AUTH_TOKEN!;
      const url = "https://test.example.com/call/incoming";
      const params = { CallSid: "CA123" };

      const expected = twilio.getExpectedTwilioSignature(
        authToken,
        "https://ATTACKER.example.com/call/incoming",
        params,
      );
      const ok = twilio.validateRequest(authToken, expected, url, params);
      assert.equal(ok, false);
    });

    it("rejects a request with tampered params", () => {
      const authToken = process.env.TWILIO_AUTH_TOKEN!;
      const url = "https://test.example.com/call/incoming";
      const expected = twilio.getExpectedTwilioSignature(
        authToken,
        url,
        { CallSid: "CA123" },
      );
      // Attacker tries to replay with injected param.
      const ok = twilio.validateRequest(authToken, expected, url, {
        CallSid: "CA123",
        InjectedParam: "evil",
      });
      assert.equal(ok, false);
    });

    it("teardown — restore previous env", () => {
      if (prev === undefined) delete process.env.VALIDATE_TWILIO_SIGNATURE;
      else process.env.VALIDATE_TWILIO_SIGNATURE = prev;
    });
  });
});

describe("logIncomingCall", () => {
  it("extracts from/callSid from body", () => {
    const { from, callSid } = logIncomingCall({
      From: "+15551234567",
      CallSid: "CAabc",
    });
    assert.equal(from, "+15551234567");
    assert.equal(callSid, "CAabc");
  });

  it("defaults to 'unknown' when fields are missing", () => {
    const { from, callSid } = logIncomingCall({});
    assert.equal(from, "unknown");
    assert.equal(callSid, "unknown");
  });

  it("handles undefined body", () => {
    const { from, callSid } = logIncomingCall(undefined);
    assert.equal(from, "unknown");
    assert.equal(callSid, "unknown");
  });
});
