/**
 * tests/consent.test.ts — SMS keyword classification + suppression list +
 * footer handling (src/core/consent.ts).
 */

import "./helpers/setupEnv.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  classifyKeyword,
  appendFooterOnce,
  OPT_OUT_FOOTER,
  isSuppressed,
  suppress,
  unsuppress,
} from "../src/core/consent.js";
import {
  _resetKvForTests,
  _setKvForTests,
  _MemoryKvForTests as MemoryKv,
} from "../src/services/kv.js";

beforeEach(() => _setKvForTests(new MemoryKv()));
afterEach(() => _resetKvForTests());

describe("classifyKeyword", () => {
  for (const w of ["STOP", "stop", "Stop.", "  STOP  ", "UNSUBSCRIBE", "cancel", "END", "QUIT", "stop please"]) {
    it(`classifies "${w}" as stop`, () => assert.equal(classifyKeyword(w), "stop"));
  }
  for (const w of ["START", "start", "UNSTOP", "yes"]) {
    it(`classifies "${w}" as start`, () => assert.equal(classifyKeyword(w), "start"));
  }
  for (const w of ["HELP", "help", "INFO", "info"]) {
    it(`classifies "${w}" as help`, () => assert.equal(classifyKeyword(w), "help"));
  }
  for (const w of ["hello", "I need to reschedule", "", "  ", "stopwatch please... "]) {
    it(`treats "${w}" as a non-keyword (null)`, () =>
      assert.equal(classifyKeyword(w), null));
  }
  it("returns null for undefined", () => assert.equal(classifyKeyword(undefined), null));
});

describe("appendFooterOnce", () => {
  it("appends the footer when absent", () => {
    const out = appendFooterOnce("Your reminder is set.");
    assert.ok(out.includes(OPT_OUT_FOOTER));
    assert.equal(out.split(OPT_OUT_FOOTER).length - 1, 1, "exactly one footer");
  });

  it("does NOT double the footer when already present", () => {
    const withFooter = `Already here. ${OPT_OUT_FOOTER}`;
    const out = appendFooterOnce(withFooter);
    assert.equal(out.split(OPT_OUT_FOOTER).length - 1, 1, "exactly one footer");
  });

  it("is idempotent across repeated application", () => {
    const once = appendFooterOnce("hi");
    const twice = appendFooterOnce(once);
    assert.equal(twice.split(OPT_OUT_FOOTER).length - 1, 1);
  });
});

describe("suppression list", () => {
  it("round-trips suppress → isSuppressed → unsuppress", async () => {
    const phone = "+15551230123";
    assert.equal(await isSuppressed(phone), false);
    await suppress(phone);
    assert.equal(await isSuppressed(phone), true);
    await unsuppress(phone);
    assert.equal(await isSuppressed(phone), false);
  });

  it("isolates different numbers", async () => {
    await suppress("+15551110000");
    assert.equal(await isSuppressed("+15552220000"), false);
  });
});
