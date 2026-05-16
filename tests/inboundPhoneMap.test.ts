/**
 * tests/inboundPhoneMap.test.ts — Tests for the parser/lookup that
 * powers INBOUND_PHONE_VOICE_MAP, exercised via the pure helpers so
 * we don't have to mutate process.env mid-process.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseInboundPhoneMap,
  lookupInboundPhoneIn,
} from "../src/config/inboundPhoneMap.js";

describe("parseInboundPhoneMap", () => {
  it("returns an empty map for missing input", () => {
    assert.deepEqual(parseInboundPhoneMap(undefined), {});
    assert.deepEqual(parseInboundPhoneMap(""), {});
  });

  it("returns an empty map and does NOT throw on invalid JSON", () => {
    assert.deepEqual(parseInboundPhoneMap("{not json"), {});
  });

  it("returns an empty map when the JSON is not an object", () => {
    assert.deepEqual(parseInboundPhoneMap('["+13143948500"]'), {});
    assert.deepEqual(parseInboundPhoneMap('"+13143948500"'), {});
    assert.deepEqual(parseInboundPhoneMap("null"), {});
  });

  it("skips entries missing voiceId or role", () => {
    const m = parseInboundPhoneMap(
      JSON.stringify({
        "+13143948500": { voiceId: "2ydcbtd5sJZRYFMNgMVZ", role: "parent" },
        "+15550000000": { voiceId: "2ydcbtd5sJZRYFMNgMVZ" }, // missing role
        "+15551111111": { role: "parent" },                  // missing voiceId
      }),
    );
    assert.deepEqual(Object.keys(m), ["+13143948500"]);
  });

  it("rejects entries whose voiceId fails the format check", () => {
    const m = parseInboundPhoneMap(
      JSON.stringify({
        "+13143948500": { voiceId: "2ydcbtd5sJZRYFMNgMVZ", role: "parent" },
        "+15552222222": { voiceId: "../etc/passwd",       role: "parent" },
        "+15553333333": { voiceId: "short",                role: "parent" },
        "+15554444444": { voiceId: "has spaces in id 0000", role: "parent" },
      }),
    );
    assert.deepEqual(Object.keys(m), ["+13143948500"]);
  });

  it("rejects entries whose role is not in VALID_ROLES", () => {
    const m = parseInboundPhoneMap(
      JSON.stringify({
        "+13143948500": { voiceId: "2ydcbtd5sJZRYFMNgMVZ", role: "parent" },
        "+15555555555": { voiceId: "2ydcbtd5sJZRYFMNgMVZ", role: "parnt" }, // typo
        "+15556666666": { voiceId: "2ydcbtd5sJZRYFMNgMVZ", role: "admin" }, // not a role
      }),
    );
    assert.deepEqual(Object.keys(m), ["+13143948500"]);
  });

  it("normalizes keys to E.164 with leading +", () => {
    const m = parseInboundPhoneMap(
      JSON.stringify({
        "13143948500":       { voiceId: "2ydcbtd5sJZRYFMNgMVZ", role: "parent" },
        "+1 (555) 000-0000": { voiceId: "EXAVITQu4vr4xnSDxMaL", role: "attorney" },
      }),
    );
    assert.ok(m["+13143948500"]);
    assert.ok(m["+15550000000"]);
  });
});

describe("lookupInboundPhoneIn", () => {
  const m = parseInboundPhoneMap(
    JSON.stringify({
      "+13143948500": { voiceId: "2ydcbtd5sJZRYFMNgMVZ", role: "parent" },
    }),
  );

  it("returns the entry for the exact E.164 number", () => {
    const e = lookupInboundPhoneIn(m, "+13143948500");
    assert.deepEqual(e, { voiceId: "2ydcbtd5sJZRYFMNgMVZ", role: "parent" });
  });

  it("normalizes the lookup key — whitespace, missing +, punctuation", () => {
    assert.ok(lookupInboundPhoneIn(m, "13143948500"));
    assert.ok(lookupInboundPhoneIn(m, "+1 314 394 8500"));
    assert.ok(lookupInboundPhoneIn(m, "+1-(314)-394-8500"));
  });

  it("returns null for unknown numbers or missing input", () => {
    assert.equal(lookupInboundPhoneIn(m, "+15555555555"), null);
    assert.equal(lookupInboundPhoneIn(m, ""), null);
    assert.equal(lookupInboundPhoneIn(m, undefined), null);
  });
});
