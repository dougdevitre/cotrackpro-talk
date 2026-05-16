/**
 * config/inboundPhoneMap.ts — Per-phone-number voice/role overrides
 *
 * Reads INBOUND_PHONE_VOICE_MAP (a JSON object) and exposes a
 * normalized lookup keyed by E.164 phone number. /call/incoming uses
 * this to map a Twilio "To" number to a specific ElevenLabs voice and
 * CoTrackPro role, so adding a new number doesn't require a code
 * change.
 *
 * Mirrors the defensive parsing pattern in src/config/voices.ts: on
 * malformed JSON we log once and return an empty map rather than
 * throwing, so a bad override never takes the whole webhook offline.
 */

import type { CoTrackProRole } from "../types/index.js";
import { env } from "./env.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ config: "inboundPhoneMap" });

export interface InboundPhoneEntry {
  voiceId: string;
  role: CoTrackProRole;
}

export type InboundPhoneMap = Record<string, InboundPhoneEntry>;

/** Strip whitespace/punctuation and ensure leading "+", so "13143948500",
 *  "+1 314 394 8500", and "+13143948500" all collapse to the same key. */
function normalize(num: string): string {
  const stripped = num.replace(/[\s\-().]/g, "");
  if (!stripped) return "";
  return stripped.startsWith("+") ? stripped : `+${stripped}`;
}

/** Pure parser — exported so tests can exercise it without env mutation. */
export function parseInboundPhoneMap(raw: string | undefined): InboundPhoneMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Invalid INBOUND_PHONE_VOICE_MAP JSON — ignoring");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("INBOUND_PHONE_VOICE_MAP must be a JSON object — ignoring");
    return {};
  }
  const out: InboundPhoneMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = v as Partial<InboundPhoneEntry> | undefined;
    if (!entry || typeof entry.voiceId !== "string" || typeof entry.role !== "string") {
      log.warn({ key: k }, "Skipping malformed inbound phone entry");
      continue;
    }
    const key = normalize(k);
    if (key) out[key] = { voiceId: entry.voiceId, role: entry.role as CoTrackProRole };
  }
  return out;
}

const phoneMap: InboundPhoneMap = parseInboundPhoneMap(env.inboundPhoneVoiceMap);

/** Look up a per-phone override. Returns null if `to` is missing,
 *  unparseable, or not in the configured map. */
export function lookupInboundPhone(to: string | undefined): InboundPhoneEntry | null {
  if (!to) return null;
  const key = normalize(to);
  return phoneMap[key] ?? null;
}

/** Lookup against an arbitrary parsed map — used by callers that build
 *  their own map (e.g. tests). */
export function lookupInboundPhoneIn(
  map: InboundPhoneMap,
  to: string | undefined,
): InboundPhoneEntry | null {
  if (!to) return null;
  const key = normalize(to);
  return map[key] ?? null;
}
