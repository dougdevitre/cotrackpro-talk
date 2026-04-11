/**
 * tests/helpers/setupEnv.ts — Test environment bootstrap.
 *
 * `src/config/env.ts` validates required env vars at import time and
 * throws on anything missing. That's correct behavior for real runs
 * but it means importing any module that transitively touches env.ts
 * will blow up in tests unless the vars are pre-set.
 *
 * Every test file imports this module FIRST, before any src/* imports,
 * so these assignments run before env.ts's module code. ESM guarantees
 * that import order at the top of a file matches the order the
 * dependency subtrees are evaluated when there's no dependency between
 * them, so this is reliable.
 *
 * All values are obviously fake — nothing here should ever hit a real
 * network.
 */

// Required Twilio vars — env.ts calls required() on each.
process.env.TWILIO_ACCOUNT_SID ??= "ACtest0000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN ??= "test_auth_token";
process.env.TWILIO_PHONE_NUMBER ??= "+15551234567";

// Required ElevenLabs and Anthropic keys.
process.env.ELEVENLABS_API_KEY ??= "test_elevenlabs_key";
process.env.ANTHROPIC_API_KEY ??= "test_anthropic_key";

// Domain — set SERVER_DOMAIN so single-host resolution works without
// requiring API_DOMAIN/WS_DOMAIN separately.
process.env.SERVER_DOMAIN ??= "test.example.com";

// Keep DynamoDB disabled in tests so we don't need AWS creds.
process.env.DYNAMO_ENABLED ??= "false";

// Make sure logging doesn't spam test output.
process.env.LOG_LEVEL ??= "silent";

// Default rate limits high enough to not interfere with most tests.
// Individual tests can re-import env or stub these per-test.
process.env.OUTBOUND_RATE_LIMIT_PER_MIN ??= "1000";
process.env.OUTBOUND_RATE_LIMIT_PER_HOUR ??= "10000";
// Records rate limits — set to a low-ish value for the tripping test
// in tests/records.test.ts (which floods until 429). 150 is enough
// to cover legitimate test traffic but low enough to trip in <200
// iterations.
process.env.RECORDS_RATE_LIMIT_PER_MIN ??= "150";
process.env.RECORDS_RATE_LIMIT_PER_HOUR ??= "10000";

// E-2 session cap. Set high enough that no tests trip it unless
// they explicitly test the cap behavior.
process.env.MAX_CONCURRENT_SESSIONS ??= "1000";

// E-4 dynamo retry budget.
process.env.DYNAMO_MAX_RETRIES ??= "3";

// E-5 external-service timeouts. Short-ish so timeout tests don't
// take forever if we ever add them.
process.env.ANTHROPIC_STREAM_TIMEOUT_MS ??= "5000";
process.env.ELEVENLABS_CONNECT_TIMEOUT_MS ??= "2000";

// KV backend: memory (default anyway, but be explicit).
process.env.KV_BACKEND ??= "memory";

// This module has no exports — it's purely a side-effect import.
export {};
