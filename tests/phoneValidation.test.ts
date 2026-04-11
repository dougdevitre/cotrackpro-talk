/**
 * tests/phoneValidation.test.ts — Tests for C-1: E.164 validation +
 * country allow-list.
 */

import "./helpers/setupEnv.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  validateDialable,
  _resetPhoneValidationCacheForTests,
} from "../src/core/phoneValidation.js";

/**
 * phoneValidation caches its parse of OUTBOUND_ALLOWED_COUNTRY_CODES
 * on first call. Tests that flip the env var must reset the cache.
 * We also have to update the env var BEFORE importing the module the
 * first time — but since setupEnv.ts has already run, we rely on
 * _resetPhoneValidationCacheForTests to re-read.
 */
function withCountries<T>(codes: string, fn: () => T): T {
  const prev = process.env.OUTBOUND_ALLOWED_COUNTRY_CODES;
  process.env.OUTBOUND_ALLOWED_COUNTRY_CODES = codes;
  _resetPhoneValidationCacheForTests();
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.OUTBOUND_ALLOWED_COUNTRY_CODES;
    } else {
      process.env.OUTBOUND_ALLOWED_COUNTRY_CODES = prev;
    }
    _resetPhoneValidationCacheForTests();
  }
}

describe("validateDialable — E.164 format", () => {
  beforeEach(() => {
    _resetPhoneValidationCacheForTests();
  });

  afterEach(() => {
    _resetPhoneValidationCacheForTests();
  });

  it("rejects missing input", () => {
    const r = validateDialable(undefined);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "not_e164");
  });

  it("rejects the empty string", () => {
    const r = validateDialable("");
    assert.equal(r.ok, false);
  });

  it("rejects a number missing the leading '+'", () => {
    const r = validateDialable("15551234567");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "not_e164");
  });

  it("rejects a number with letters", () => {
    const r = validateDialable("+1555CALL");
    assert.equal(r.ok, false);
  });

  it("rejects a number with a leading zero in the country code", () => {
    const r = validateDialable("+01234567890");
    assert.equal(r.ok, false);
  });

  it("rejects a number longer than 15 digits (E.164 max)", () => {
    const r = validateDialable("+1234567890123456"); // 16 digits
    assert.equal(r.ok, false);
  });

  it("rejects a number with spaces", () => {
    const r = validateDialable("+1 555 123 4567");
    assert.equal(r.ok, false);
  });

  it("rejects a number with dashes", () => {
    const r = validateDialable("+1-555-123-4567");
    assert.equal(r.ok, false);
  });
});

describe("validateDialable — US/CA allow-list (default)", () => {
  beforeEach(() => {
    _resetPhoneValidationCacheForTests();
  });

  it("accepts a valid US number", () => {
    const r = validateDialable("+15551234567");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.iso, "NANP");
  });

  it("accepts a valid Canadian number (same NANP prefix as US)", () => {
    // +1 (416) XXX-XXXX — Toronto
    const r = validateDialable("+14165551234");
    assert.equal(r.ok, true);
  });

  it("rejects a UK number", () => {
    const r = validateDialable("+442071234567");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "country_not_allowed");
  });

  it("rejects a French number", () => {
    const r = validateDialable("+33123456789");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "country_not_allowed");
  });

  it("rejects a premium-rate international number (978 UAE)", () => {
    const r = validateDialable("+971501234567");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "country_not_allowed");
  });

  it("rejects a number with an unknown country code", () => {
    // +999 is unassigned.
    const r = validateDialable("+9991234567");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "unknown_country");
  });
});

describe("validateDialable — wildcard bypass", () => {
  it("accepts any valid E.164 number when OUTBOUND_ALLOWED_COUNTRY_CODES='*'", () => {
    withCountries("*", () => {
      assert.equal(validateDialable("+15551234567").ok, true);
      assert.equal(validateDialable("+442071234567").ok, true);
      assert.equal(validateDialable("+33123456789").ok, true);
    });
  });

  it("still rejects non-E.164 input when wildcarded", () => {
    withCountries("*", () => {
      assert.equal(validateDialable("not a number").ok, false);
    });
  });
});

describe("validateDialable — custom allow-list", () => {
  it("accepts GB when OUTBOUND_ALLOWED_COUNTRY_CODES='GB'", () => {
    withCountries("GB", () => {
      const r = validateDialable("+442071234567");
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.iso, "GB");
    });
  });

  it("rejects US when OUTBOUND_ALLOWED_COUNTRY_CODES='GB'", () => {
    withCountries("GB", () => {
      const r = validateDialable("+15551234567");
      assert.equal(r.ok, false);
    });
  });

  it("handles whitespace in the env var", () => {
    withCountries("US ,  CA , GB", () => {
      assert.equal(validateDialable("+15551234567").ok, true);
      assert.equal(validateDialable("+442071234567").ok, true);
      assert.equal(validateDialable("+33123456789").ok, false);
    });
  });

  it("handles lower-case ISO codes in the env var", () => {
    withCountries("us,ca", () => {
      assert.equal(validateDialable("+15551234567").ok, true);
    });
  });
});
