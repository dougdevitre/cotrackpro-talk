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
  validateInboundPhoneMap,
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

describe("validateInboundPhoneMap (strict, used by lint:config)", () => {
  const VALID_ID = "2ydcbtd5sJZRYFMNgMVZ";

  it("treats empty/undefined input as valid (no overrides is a valid state)", () => {
    const a = validateInboundPhoneMap(undefined);
    const b = validateInboundPhoneMap("");
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (a.ok && b.ok) {
      assert.deepEqual(a.map, {});
      assert.deepEqual(b.map, {});
    }
  });

  it("returns an error with /JSON/ message on malformed JSON", () => {
    const r = validateInboundPhoneMap("{not json");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0]!.message, /JSON/);
    }
  });

  it("rejects non-object top-level values", () => {
    for (const raw of ["[]", '"+13143948500"', "null", "42"]) {
      const r = validateInboundPhoneMap(raw);
      assert.equal(r.ok, false, `expected error for ${raw}`);
      if (!r.ok) {
        assert.match(r.errors[0]!.message, /object/);
      }
    }
  });

  it("flags entries with a bad voiceId and names the offending key", () => {
    const r = validateInboundPhoneMap(
      JSON.stringify({
        "+13143948500": { voiceId: VALID_ID, role: "parent" },
        "+15552222222": { voiceId: "../etc/passwd", role: "parent" },
      }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      const bad = r.errors.find((e) => e.key === "+15552222222");
      assert.ok(bad, "error should reference the offending key");
      assert.match(bad!.message, /voiceId/);
    }
  });

  it("flags entries whose role is not in VALID_ROLES", () => {
    const r = validateInboundPhoneMap(
      JSON.stringify({
        "+13143948500": { voiceId: VALID_ID, role: "parnt" },
      }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.errors[0]!.message, /role/);
    }
  });

  it("collapses duplicate keys after normalization and flags the collision", () => {
    const r = validateInboundPhoneMap(
      JSON.stringify({
        "+13143948500": { voiceId: VALID_ID, role: "parent" },
        "13143948500":   { voiceId: VALID_ID, role: "attorney" },
      }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      const dup = r.errors.find((e) => /collide|collision/i.test(e.message));
      assert.ok(dup, "should flag the normalization collision");
    }
  });

  it("accepts a well-formed map and returns the parsed result", () => {
    const r = validateInboundPhoneMap(
      JSON.stringify({
        "+13143948500": { voiceId: VALID_ID, role: "parent" },
        "+15550000000": { voiceId: "EXAVITQu4vr4xnSDxMaL", role: "attorney" },
      }),
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(Object.keys(r.map).sort(), ["+13143948500", "+15550000000"]);
      assert.equal(r.map["+13143948500"]!.role, "parent");
    }
  });

  it("round-trips on lenient + strict for the same well-formed input", () => {
    const raw = JSON.stringify({
      "+13143948500": { voiceId: VALID_ID, role: "parent" },
    });
    const strict = validateInboundPhoneMap(raw);
    const lenient = parseInboundPhoneMap(raw);
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.deepEqual(strict.map, lenient);
    }
  });
});
