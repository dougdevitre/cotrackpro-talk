/**
 * tests/helpers/setupEnvUnconfigured.ts — Test bootstrap simulating a
 * PRODUCTION deploy with the shared talk bearer UNSET, to exercise the
 * "503 unconfigured" auth branch. Import FIRST.
 *
 * Note: we deliberately do NOT set TALK_OUTBOUND_API_KEY / OUTBOUND_API_KEY
 * and we force NODE_ENV=production so authorizeHubBearer fails closed.
 */

import "./setupEnv.js";

process.env.NODE_ENV = "production";
delete process.env.TALK_OUTBOUND_API_KEY;
delete process.env.OUTBOUND_API_KEY;

export {};
