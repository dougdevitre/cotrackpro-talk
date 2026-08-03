/**
 * tests/greetings.test.ts
 *
 * Every caller must be told the call is transcribed before they say anything.
 * The transcript is persisted (core/callCompletion.ts → services/dynamo.ts), and
 * in two-party-consent states recording a conversation without notice is a
 * wiretap question — so this is a legal invariant, not a copy preference.
 *
 * These tests pin the invariant to the role list rather than to a fixed set of
 * greetings, so adding a role to CoTrackProRole cannot ship an undisclosed line.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getRoleGreeting,
  TRANSCRIPTION_NOTICE,
  TRANSCRIPTION_NOTICE_KID_TEEN,
} from "../src/audio/greetings.js";
import type { CoTrackProRole } from "../src/types/index.js";

const ALL_ROLES: CoTrackProRole[] = [
  "parent", "attorney", "gal", "judge", "therapist", "school_counselor",
  "law_enforcement", "mediator", "advocate", "kid_teen", "social_worker",
  "cps", "evaluator",
];

describe("spoken transcription disclosure", () => {
  for (const role of ALL_ROLES) {
    test(`${role} is told the call is transcribed`, () => {
      const greeting = getRoleGreeting(role);
      assert.match(greeting, /transcribed|written down/);
      assert.match(greeting, /saved/);
    });

    test(`${role} is told this is not legal or clinical advice`, () => {
      const greeting = getRoleGreeting(role);
      assert.match(greeting, /not legal or clinical advice|not a lawyer or a counselor/);
    });

    test(`${role} hears the disclosure before the welcome`, () => {
      const greeting = getRoleGreeting(role);
      const noticeEnd = greeting.indexOf("advice") >= 0
        ? greeting.indexOf("advice")
        : greeting.indexOf("think things through");
      const welcome = greeting.indexOf("Welcome to CoTrack Pro");
      // A role with no custom body still gets the default welcome; either way
      // the notice has to come first, not be appended after the pleasantries.
      if (welcome >= 0) assert.ok(noticeEnd < welcome, "notice must precede the welcome");
    });
  }

  test("the kid/teen line gets its own plain-language wording", () => {
    const greeting = getRoleGreeting("kid_teen");
    assert.ok(greeting.startsWith(TRANSCRIPTION_NOTICE_KID_TEEN));
    assert.ok(!greeting.includes(TRANSCRIPTION_NOTICE));
    // A minor is least likely to assume a help line is recorded, so the wording
    // states the transcript is not private rather than implying it.
    assert.match(greeting, /isn't only\s+between us/);
  });

  test("every adult role shares one notice, so wording cannot drift per role", () => {
    const adultRoles = ALL_ROLES.filter((r) => r !== "kid_teen");
    for (const role of adultRoles) {
      assert.ok(
        getRoleGreeting(role).startsWith(TRANSCRIPTION_NOTICE),
        `${role} should open with the shared notice`,
      );
    }
  });
});
