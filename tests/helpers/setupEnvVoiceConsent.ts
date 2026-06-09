/**
 * tests/helpers/setupEnvVoiceConsent.ts — voice env with the consent gate
 * ENABLED (REQUIRE_VOICE_CONSENT=true), so placeVoiceCall enforces the
 * per-request `consent` attestation. Import FIRST. Builds on setupEnvVoice
 * (bearer + doug voice + low daily cap).
 */

import "./setupEnvVoice.js";

process.env.REQUIRE_VOICE_CONSENT = "true";

export {};
