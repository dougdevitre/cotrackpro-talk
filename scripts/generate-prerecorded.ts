/**
 * scripts/generate-prerecorded.ts
 *
 * One-time build script that pre-generates fixed-phrase audio for every
 * (phrase, voiceId) combination and writes the result to
 * src/audio/prerecorded.ts as exported base64 chunk arrays.
 *
 * Why: Every call plays the same role greeting and sometimes the same
 * hold/error phrases. Pre-generating once eliminates ~200ms of TTS
 * handshake latency AND removes per-call TTS cost for these phrases.
 *
 * USAGE:
 *   npm run generate-audio
 *
 * REQUIREMENTS:
 *   ELEVENLABS_API_KEY must be set in .env or environment.
 *   ELEVENLABS_MODEL_ID (optional, defaults to eleven_flash_v2_5).
 *
 * OUTPUT:
 *   src/audio/prerecorded.ts — overwritten with generated constants.
 *
 * RE-RUN WHEN:
 *   - A phrase text in FIXED_PHRASES changes
 *   - A voice ID in src/config/voices.ts changes
 *   - You add or remove a role
 */

import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_VOICE_MAP } from "../src/config/voices.js";
import type { CoTrackProRole } from "../src/types/index.js";

// Use process.cwd() — tsx runs this script from the project root
const PROJECT_ROOT = process.cwd();

// ── Fixed phrases to pre-generate ──────────────────────────────────────────
// Keep in sync with getRoleGreeting() in src/handlers/callHandler.ts
// and the error/hold messages used in the same file.

type GreetingTextMap = Record<CoTrackProRole, string>;

const GREETING_TEXTS: GreetingTextMap = {
  kid_teen:
    "Hey there. Welcome to CoTrack Pro. " +
    "This is a safe place where you can talk about what's going on. " +
    "There are no wrong answers, and you can stop anytime you want. " +
    "What's on your mind?",
  parent:
    "Welcome to CoTrack Pro. I'm here to help with documentation, " +
    "safety planning, and co-parenting support. " +
    "Everything we talk about today is on your terms, and we can go at your pace. " +
    "How can I help you today?",
  attorney:
    "Welcome to CoTrack Pro. I'm ready to assist with documentation, " +
    "case organization, and evidence support. " +
    "How can I help you today?",
  gal:
    "Welcome to CoTrack Pro. I'm ready to assist with documentation, " +
    "case organization, and evidence support. " +
    "How can I help you today?",
  judge:
    "Welcome to CoTrack Pro. I'm ready to assist with documentation, " +
    "case organization, and evidence support. " +
    "How can I help you today?",
  therapist:
    "Welcome to CoTrack Pro. I'm here to support your documentation " +
    "and help organize observations. " +
    "What are you working on today?",
  social_worker:
    "Welcome to CoTrack Pro. I'm here to support your documentation " +
    "and help organize observations. " +
    "What are you working on today?",
  school_counselor:
    "Welcome to CoTrack Pro. I'm here to support your documentation " +
    "and help organize observations. " +
    "What are you working on today?",
  advocate:
    "Welcome to CoTrack Pro. I'm here to support your work " +
    "with safety planning, documentation, and resource connection. " +
    "How can I help today?",
  // Roles without a custom greeting use the default
  law_enforcement:
    "Welcome to CoTrack Pro. I'm here to help with documentation, " +
    "safety planning, and co-parenting support. " +
    "How can I help you today?",
  mediator:
    "Welcome to CoTrack Pro. I'm here to help with documentation, " +
    "safety planning, and co-parenting support. " +
    "How can I help you today?",
  cps:
    "Welcome to CoTrack Pro. I'm here to help with documentation, " +
    "safety planning, and co-parenting support. " +
    "How can I help you today?",
  evaluator:
    "Welcome to CoTrack Pro. I'm here to help with documentation, " +
    "safety planning, and co-parenting support. " +
    "How can I help you today?",
};

const HOLD_TEXT = "I'm working on that for you right now. I'm still here.";

const ERROR_GENERIC_TEXT =
  "I'm still here with you. I had a brief technical hiccup on my end, " +
  "but I'm ready whenever you are. Go ahead.";

const ERROR_TOOL_TEXT =
  "I'm still here. Something went wrong on my end with that last step, " +
  "but don't worry, nothing was lost. What would you like to do next?";

// ── ElevenLabs REST client ─────────────────────────────────────────────────

const API_KEY = process.env.ELEVENLABS_API_KEY;
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? "eleven_flash_v2_5";

if (!API_KEY) {
  console.error("ERROR: ELEVENLABS_API_KEY not set. Add it to .env or export it.");
  process.exit(1);
}

/** Fetch TTS audio as raw ulaw_8000 bytes. */
async function generateAudio(text: string, voiceId: string): Promise<Buffer> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=ulaw_8000`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": API_KEY!,
      "Content-Type": "application/json",
      Accept: "audio/basic",
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs REST ${res.status}: ${body}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Chunk raw ulaw_8000 audio into Twilio-compatible frames.
 * Twilio expects 20ms frames = 160 bytes at 8kHz mulaw.
 * Each chunk is base64-encoded for the final JSON envelope.
 */
function chunkToBase64Frames(raw: Buffer, frameBytes = 160): string[] {
  const frames: string[] = [];
  for (let i = 0; i < raw.length; i += frameBytes) {
    const frame = raw.subarray(i, Math.min(i + frameBytes, raw.length));
    frames.push(frame.toString("base64"));
  }
  return frames;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("Pre-generating fixed-phrase audio cache...");
  console.log(`Model: ${MODEL_ID}`);

  // Enumerate unique voice IDs used across all roles
  const uniqueVoiceIds = Array.from(new Set(Object.values(DEFAULT_VOICE_MAP)));
  console.log(`Distinct voices: ${uniqueVoiceIds.length}`);

  // Per-role greeting audio, keyed by role (each role → its voice's audio)
  const greetings: Record<string, string[]> = {};
  // Fixed phrases shared across roles, keyed by voice ID
  const holdByVoice: Record<string, string[]> = {};
  const errorGenericByVoice: Record<string, string[]> = {};
  const errorToolByVoice: Record<string, string[]> = {};

  // 1. Greetings: one per role (uses role's voice)
  for (const [role, voiceId] of Object.entries(DEFAULT_VOICE_MAP)) {
    if (!voiceId) continue;
    const text = GREETING_TEXTS[role as CoTrackProRole];
    if (!text) continue;
    process.stdout.write(`  greeting[${role}] (${voiceId}) ... `);
    const raw = await generateAudio(text, voiceId);
    greetings[role] = chunkToBase64Frames(raw);
    console.log(`${raw.length} bytes, ${greetings[role].length} frames`);
  }

  // 2. Hold + error phrases: one per unique voice
  for (const voiceId of uniqueVoiceIds) {
    process.stdout.write(`  hold (${voiceId}) ... `);
    const holdRaw = await generateAudio(HOLD_TEXT, voiceId);
    holdByVoice[voiceId] = chunkToBase64Frames(holdRaw);
    console.log(`${holdRaw.length} bytes`);

    process.stdout.write(`  error-generic (${voiceId}) ... `);
    const errRaw = await generateAudio(ERROR_GENERIC_TEXT, voiceId);
    errorGenericByVoice[voiceId] = chunkToBase64Frames(errRaw);
    console.log(`${errRaw.length} bytes`);

    process.stdout.write(`  error-tool (${voiceId}) ... `);
    const errToolRaw = await generateAudio(ERROR_TOOL_TEXT, voiceId);
    errorToolByVoice[voiceId] = chunkToBase64Frames(errToolRaw);
    console.log(`${errToolRaw.length} bytes`);
  }

  // 3. Write output module
  const outPath = resolve(PROJECT_ROOT, "src/audio/prerecorded.ts");
  mkdirSync(dirname(outPath), { recursive: true });

  const output = `/**
 * src/audio/prerecorded.ts
 *
 * AUTO-GENERATED by scripts/generate-prerecorded.ts — do not edit by hand.
 * Run \`npm run generate-audio\` to regenerate.
 *
 * Each value is an array of base64-encoded ulaw_8000 frames (160 bytes each,
 * 20ms of audio per frame) ready to be placed in Twilio media messages.
 */

/** Role-keyed greeting audio. Each role's audio is rendered in its own voice. */
export const GREETINGS_ULAW: Record<string, string[]> = ${JSON.stringify(greetings, null, 2)};

/** Hold message ("I'm working on that...") keyed by voice ID. */
export const HOLD_ULAW: Record<string, string[]> = ${JSON.stringify(holdByVoice, null, 2)};

/** Generic processing error keyed by voice ID. */
export const ERROR_GENERIC_ULAW: Record<string, string[]> = ${JSON.stringify(errorGenericByVoice, null, 2)};

/** Tool-follow-up error keyed by voice ID. */
export const ERROR_TOOL_ULAW: Record<string, string[]> = ${JSON.stringify(errorToolByVoice, null, 2)};

/** Text versions for conversation-history bookkeeping. Kept in sync with the above. */
export const GREETING_TEXTS: Record<string, string> = ${JSON.stringify(GREETING_TEXTS_OBJECT, null, 2)};
export const HOLD_TEXT = ${JSON.stringify(HOLD_TEXT)};
export const ERROR_GENERIC_TEXT = ${JSON.stringify(ERROR_GENERIC_TEXT)};
export const ERROR_TOOL_TEXT = ${JSON.stringify(ERROR_TOOL_TEXT)};
`;

  writeFileSync(outPath, output, "utf8");
  console.log(`\nWrote ${outPath}`);

  const totalFrames =
    Object.values(greetings).reduce((s, f) => s + f.length, 0) +
    Object.values(holdByVoice).reduce((s, f) => s + f.length, 0) +
    Object.values(errorGenericByVoice).reduce((s, f) => s + f.length, 0) +
    Object.values(errorToolByVoice).reduce((s, f) => s + f.length, 0);
  console.log(`Total frames: ${totalFrames} (~${Math.round(totalFrames * 0.02)}s audio)`);
}

// Helper: plain object form of GREETING_TEXTS for JSON.stringify
const GREETING_TEXTS_OBJECT = { ...GREETING_TEXTS };

main().catch((err) => {
  console.error("generate-prerecorded failed:", err);
  process.exit(1);
});
