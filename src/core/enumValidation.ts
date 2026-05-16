/**
 * core/enumValidation.ts — Runtime validation for role and status
 * enums that arrive from URL path segments, query params, or request
 * bodies.
 *
 * Why this file exists: previously `src/core/records.ts` cast
 * incoming role/status strings directly to the enum type
 * (`role as CoTrackProRole`), which is a lie — there's no runtime
 * check. /records/by-role/administrator would return empty records
 * instead of 400, which is confusing for callers and slightly
 * dangerous in a couple of downstream code paths that index the
 * role into voice-config maps.
 *
 * Flagged as H-2 and H-3 in
 * docs/CODE_REVIEW-vercel-hosting-optimization.md.
 *
 * Two styles of helper here:
 *
 *   - `isValidRole`/`isValidStatus` — type predicates for
 *     "trust-but-verify" contexts where the caller wants to branch.
 *   - `normalizeRole` — the lenient version for inbound TwiML
 *     handlers where an unknown role should fall back to "parent"
 *     rather than reject the call entirely. We log a warning so
 *     mis-configured Twilio webhooks are visible in observability.
 */

import type { CoTrackProRole } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { isValidRole } from "./roleSet.js";

// Re-export the pure surface so existing callers keep their imports
// unchanged. The constants + predicates live in roleSet.ts; only the
// log-emitting normalizeRole lives here because it transitively
// touches env via the logger.
export { VALID_ROLES, VALID_STATUSES, isValidRole, isValidStatus } from "./roleSet.js";

const log = logger.child({ core: "enumValidation" });

/**
 * Lenient role normalization used by TwiML handlers and the outbound
 * call initiation path. Unknown roles are mapped to "parent" (the
 * default persona) with a warning log line so misconfigurations show
 * up in observability without hard-failing a live call.
 *
 * Use `isValidRole` instead when you want strict 400 behavior.
 */
export function normalizeRole(
  role: string | undefined,
): CoTrackProRole {
  if (isValidRole(role)) return role;
  log.warn({ role }, "Unknown role — falling back to 'parent'");
  return "parent";
}
