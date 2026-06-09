/**
 * tests/helpers/setupEnvVoice.ts — Test bootstrap for outbound voice.
 *
 * Builds on setupEnvHub (shared bearer + hub + Messaging Service SID) and
 * adds the two values the one-shot voice path reads at env-load time:
 *   - ELEVENLABS_VOICE_ID_DOUG — so resolveVoiceId("doug-voice") resolves
 *     to a concrete (format-valid) voice id instead of `unprovisioned`.
 *   - CALL_DAILY_CAP — set LOW so the per-day-cap test can trip it in a
 *     handful of iterations without flooding.
 *
 * Import FIRST, before any src/* import (env.ts reads these once at
 * module-load). Node isolates each test file in its own process, so these
 * don't leak into the other suites.
 */

import "./setupEnvHub.js";

// Format-valid ElevenLabs voice id (matches VOICE_ID_RE: 16-32 alnum).
process.env.ELEVENLABS_VOICE_ID_DOUG = "DougVoiceId0000000000";
// Low daily cap so the cap test trips quickly.
process.env.CALL_DAILY_CAP = "3";

export {};
