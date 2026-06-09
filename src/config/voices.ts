/**
 * config/voices.ts — CoTrackPro role → ElevenLabs voice ID mapping
 *
 * Each CoTrackPro persona gets a distinct ElevenLabs voice.
 * Override via VOICE_MAP env var (JSON) or edit defaults below.
 *
 * To find your voice IDs:
 *   GET https://api.elevenlabs.io/v1/voices
 *   Headers: xi-api-key: <your key>
 */

import type { CoTrackProRole, VoiceMap } from "../types/index.js";
import { env } from "./env.js";
import { VOICE_ID_RE } from "../core/voiceIdFormat.js";

// ── Default voice IDs (replace with your cloned/library voice IDs) ──────────
export const DEFAULT_VOICE_MAP: VoiceMap = {
  parent: "EXAVITQu4vr4xnSDxMaL",       // "Sarah" — warm, empathetic
  attorney: "pNInz6obpgDQGcFmaJgB",      // "Adam" — professional, measured
  gal: "ErXwobaYiN019PkySvjV",           // "Antoni" — calm, authoritative
  judge: "VR6AewLTigWG4xSOukaG",         // "Arnold" — formal, deliberate
  therapist: "21m00Tcm4TlvDq8ikWAM",     // "Rachel" — gentle, reassuring
  school_counselor: "AZnzlk1XvdvUeBnXmlld", // "Domi" — friendly, approachable
  law_enforcement: "pNInz6obpgDQGcFmaJgB",  // reuse "Adam"
  mediator: "ErXwobaYiN019PkySvjV",         // reuse "Antoni"
  advocate: "EXAVITQu4vr4xnSDxMaL",         // reuse "Sarah"
  kid_teen: "AZnzlk1XvdvUeBnXmlld",         // reuse "Domi"
  social_worker: "21m00Tcm4TlvDq8ikWAM",    // reuse "Rachel"
  cps: "pNInz6obpgDQGcFmaJgB",              // reuse "Adam"
  evaluator: "VR6AewLTigWG4xSOukaG",        // reuse "Arnold"
};

// ── Merge env override on top of defaults ───────────────────────────────────
function buildVoiceMap(): VoiceMap {
  if (!env.voiceMapOverride) return DEFAULT_VOICE_MAP;
  try {
    const override: VoiceMap = JSON.parse(env.voiceMapOverride);
    return { ...DEFAULT_VOICE_MAP, ...override };
  } catch {
    console.warn("[voices] Invalid VOICE_MAP JSON — using defaults");
    return DEFAULT_VOICE_MAP;
  }
}

export const voiceMap = buildVoiceMap();

/** Resolve the ElevenLabs voice ID for a given CoTrackPro role */
export function getVoiceId(role: CoTrackProRole): string {
  return voiceMap[role] ?? DEFAULT_VOICE_MAP.parent!;
}

/**
 * Symbolic alias the hub uses for Doug's cloned voice. The hub doesn't
 * know the raw ElevenLabs voice_id — it asks for "doug-voice" and the
 * talk edge resolves it from SSM (env.elevenLabsVoiceIdDoug) at send
 * time. Keeps the actual voice_id out of the hub's contract.
 */
export const DOUG_VOICE_ALIAS = "doug-voice";

export type ResolveVoiceIdResult =
  | { ok: true; voiceId: string }
  | { ok: false; reason: "unprovisioned" | "invalid" };

/**
 * Resolve a voiceId from the outbound-voice contract to a concrete
 * ElevenLabs voice_id.
 *
 *   - "doug-voice"  → env.elevenLabsVoiceIdDoug (SSM-provisioned). Fails
 *     with `unprovisioned` when that env var is empty, so a misdeploy
 *     surfaces as a clean 5xx instead of a malformed ElevenLabs request.
 *   - a raw 16-32 char alphanumeric ElevenLabs id → passed through.
 *   - anything else → `invalid` (caller maps to 400).
 */
export function resolveVoiceId(voiceId: string | undefined): ResolveVoiceIdResult {
  if (voiceId === DOUG_VOICE_ALIAS) {
    return env.elevenLabsVoiceIdDoug
      ? { ok: true, voiceId: env.elevenLabsVoiceIdDoug }
      : { ok: false, reason: "unprovisioned" };
  }
  if (typeof voiceId === "string" && VOICE_ID_RE.test(voiceId)) {
    return { ok: true, voiceId };
  }
  return { ok: false, reason: "invalid" };
}
