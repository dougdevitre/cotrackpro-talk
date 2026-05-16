/**
 * core/voiceIdFormat.ts — Pure ElevenLabs voice-ID format check.
 *
 * Lifted out of src/core/tts.ts so callers that only need the regex
 * (pre-deploy lint script, inbound phone-map parser) don't transitively
 * load env + logger + the AI rate-limit stack.
 *
 * tts.ts re-exports these symbols so existing consumers don't change.
 */

// Very light voice_id sanity check. ElevenLabs voice IDs are 20-char
// alphanumeric strings; rejecting anything else prevents header
// injection or URL smuggling via the path segment.
export const VOICE_ID_RE = /^[A-Za-z0-9]{16,32}$/;

/** Test whether a string is a syntactically-valid ElevenLabs voice ID. */
export function isValidVoiceId(v: unknown): v is string {
  return typeof v === "string" && VOICE_ID_RE.test(v);
}
