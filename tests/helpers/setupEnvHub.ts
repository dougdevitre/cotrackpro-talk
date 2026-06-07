/**
 * tests/helpers/setupEnvHub.ts — Test bootstrap for the hub↔talk seam.
 *
 * Extends setupEnv with the two values the seam needs at env-load time:
 *   - HUB_BASE_URL    — so the Talk→Hub client (and resolveInboundCaller)
 *                       actually attempts a call instead of short-circuiting.
 *   - OUTBOUND_API_KEY — the shared bearer; set so the SMS-send auth path
 *                        and the bearer-presentation path are exercised.
 *
 * Like setupEnv, this MUST be imported FIRST in any test file that uses
 * it, before any src/* import, because src/config/env.ts reads these
 * values once at module-load time. Node's test runner isolates each test
 * file in its own process, so setting these here doesn't leak into the
 * other suites (which deliberately leave the hub disabled).
 */

import "./setupEnv.js";

process.env.HUB_BASE_URL = "https://hub.test.example.com";
process.env.OUTBOUND_API_KEY = "test-shared-bearer";
// Keep the hub timeout short so any accidental real fetch fails fast.
process.env.HUB_TIMEOUT_MS ??= "1000";

// A2P Messaging Service SID — set so SMS-send tests exercise the
// brand/campaign-attributed routing path (not a bare from-number).
process.env.TWILIO_MESSAGING_SERVICE_SID ??= "MGtest0000000000000000000000000000";

export {};
