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

// ── Default voice IDs (replace with your cloned/library voice IDs) ──────────
const DEFAULT_VOICE_MAP: VoiceMap = {
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
