/**
 * tests/enumValidation.test.ts — Tests for H-2 / H-3: runtime
 * validation of CoTrackProRole and CallStatus enum values that
 * arrive from URL path segments or query parameters.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VALID_ROLES,
  VALID_STATUSES,
  isValidRole,
  isValidStatus,
  normalizeRole,
} from "../src/core/enumValidation.js";

describe("VALID_ROLES", () => {
  it("contains every role the README claims to support", () => {
    // This list mirrors the README "Supported roles" line. If you
    // add a role to the type and forget to update VALID_ROLES, this
    // test fails — you'll get a silent 400 in prod otherwise.
    const expected = [
      "parent",
      "attorney",
      "gal",
      "judge",
      "therapist",
      "school_counselor",
      "law_enforcement",
      "mediator",
      "advocate",
      "kid_teen",
      "social_worker",
      "cps",
      "evaluator",
    ];
    assert.deepEqual([...VALID_ROLES].sort(), expected.sort());
  });
});

describe("VALID_STATUSES", () => {
  it("contains all four CallStatus values from src/types/index.ts", () => {
    assert.deepEqual(
      [...VALID_STATUSES].sort(),
      ["active", "completed", "failed", "force-reaped"].sort(),
    );
  });
});

describe("isValidRole", () => {
  it("returns true for known roles", () => {
    assert.equal(isValidRole("parent"), true);
    assert.equal(isValidRole("attorney"), true);
    assert.equal(isValidRole("cps"), true);
  });

  it("returns false for unknown roles", () => {
    assert.equal(isValidRole("administrator"), false);
    assert.equal(isValidRole("PARENT"), false); // case-sensitive
    assert.equal(isValidRole(""), false);
    assert.equal(isValidRole(undefined), false);
  });

  it("returns false for injection-shaped strings", () => {
    assert.equal(isValidRole('parent"/><Hang/>'), false);
    assert.equal(isValidRole("../../etc/passwd"), false);
  });
});

describe("isValidStatus", () => {
  it("returns true for known statuses", () => {
    assert.equal(isValidStatus("active"), true);
    assert.equal(isValidStatus("completed"), true);
    assert.equal(isValidStatus("failed"), true);
    assert.equal(isValidStatus("force-reaped"), true);
  });

  it("returns false for unknown statuses", () => {
    assert.equal(isValidStatus("pending"), false);
    assert.equal(isValidStatus("COMPLETED"), false);
    assert.equal(isValidStatus(undefined), false);
  });
});

describe("normalizeRole", () => {
  it("returns valid roles unchanged", () => {
    assert.equal(normalizeRole("attorney"), "attorney");
    assert.equal(normalizeRole("parent"), "parent");
  });

  it("falls back to 'parent' for unknown roles", () => {
    assert.equal(normalizeRole("administrator"), "parent");
  });

  it("falls back to 'parent' for undefined", () => {
    assert.equal(normalizeRole(undefined), "parent");
  });

  it("falls back to 'parent' for injection-shaped strings (H-3)", () => {
    // Normalization is the primary defense for the /call/incoming
    // role query param. escapeXmlAttr is the secondary defense.
    assert.equal(normalizeRole('parent"/><Hang/>'), "parent");
  });

  it("is case-sensitive", () => {
    // "Parent" is NOT a valid role — normalize it to "parent".
    assert.equal(normalizeRole("Parent"), "parent");
    assert.equal(normalizeRole("ATTORNEY"), "parent");
  });
});
