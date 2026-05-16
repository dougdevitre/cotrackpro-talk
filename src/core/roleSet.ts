/**
 * core/roleSet.ts — Pure runtime role/status enums.
 *
 * Lifted out of src/core/enumValidation.ts so the lint script and the
 * pure phone-map validator can use isValidRole without transitively
 * loading the logger (which pulls env).
 *
 * enumValidation.ts re-exports these symbols and adds the lenient
 * normalizeRole(), which DOES log and therefore belongs in the
 * env-coupled module.
 */

import type { CoTrackProRole, CallStatus } from "../types/index.js";

/**
 * The canonical list of valid CoTrackPro roles. Keep in sync with the
 * union type in src/types/index.ts:138-151. A test in
 * tests/enumValidation.test.ts compares this array to the type so
 * additions to the type must be mirrored here or tests fail.
 */
export const VALID_ROLES: readonly CoTrackProRole[] = [
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
] as const;

/** Canonical list of call statuses. Mirrors `CallStatus` in src/types. */
export const VALID_STATUSES: readonly CallStatus[] = [
  "active",
  "completed",
  "failed",
  "force-reaped",
] as const;

/** Type predicate: does this string belong to CoTrackProRole? */
export function isValidRole(role: string | undefined): role is CoTrackProRole {
  return typeof role === "string" && (VALID_ROLES as readonly string[]).includes(role);
}

/** Type predicate: does this string belong to CallStatus? */
export function isValidStatus(
  status: string | undefined,
): status is CallStatus {
  return (
    typeof status === "string" &&
    (VALID_STATUSES as readonly string[]).includes(status)
  );
}
