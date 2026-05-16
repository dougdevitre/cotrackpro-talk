/**
 * config/inboundPhoneMap.ts — Runtime entry point for the per-phone-
 * number voice/role override map.
 *
 * The pure validator + types live in inboundPhoneMapPure.ts so the
 * pre-deploy lint script can run without a fully-populated env. This
 * file adds the env-coupled bits: a lenient parser that emits warn
 * logs for skipped entries, and a cached `lookupInboundPhone` keyed
 * on the boot-time INBOUND_PHONE_VOICE_MAP value.
 */

import { env } from "./env.js";
import { logger } from "../utils/logger.js";
import {
  validateInboundPhoneMap,
  validateEntry,
  normalize,
  type InboundPhoneEntry,
  type InboundPhoneMap,
} from "./inboundPhoneMapPure.js";

// Re-export the pure surface so existing callers keep working without
// touching their import paths.
export {
  validateInboundPhoneMap,
  lookupInboundPhoneIn,
  normalize,
  validateEntry,
} from "./inboundPhoneMapPure.js";
export type {
  InboundPhoneEntry,
  InboundPhoneMap,
  InboundPhoneMapError,
  ValidateResult,
} from "./inboundPhoneMapPure.js";

const log = logger.child({ config: "inboundPhoneMap" });

/** Lenient parser used at boot. Mirrors the strict validator's rules
 *  but emits log.warn for each skipped entry instead of returning
 *  errors, preserving "bad config doesn't take the webhook offline"
 *  behavior from src/config/voices.ts. */
export function parseInboundPhoneMap(raw: string | undefined): InboundPhoneMap {
  const result = validateInboundPhoneMap(raw);
  if (result.ok) return result.map;

  // Group errors by key so each phone entry logs once even if it
  // failed multiple rules.
  const byKey = new Map<string, string[]>();
  const topLevel: string[] = [];
  for (const e of result.errors) {
    if (e.key === undefined) topLevel.push(e.message);
    else {
      const arr = byKey.get(e.key) ?? [];
      arr.push(e.message);
      byKey.set(e.key, arr);
    }
  }
  for (const msg of topLevel) {
    log.warn({ err: msg }, "INBOUND_PHONE_VOICE_MAP — falling back to empty map");
  }
  for (const [key, issues] of byKey) {
    log.warn({ key, issues }, "Skipping malformed inbound phone entry");
  }

  // Re-run the validator but rebuild an "accept what's salvageable"
  // map by skipping entries with errors. Since validateInboundPhoneMap
  // already short-circuits on top-level JSON errors, top-level
  // failures return an empty map — exactly what we want.
  if (topLevel.length > 0) return {};
  return rebuildLenient(raw, byKey);
}

/** Re-walk the JSON and keep only entries that had no errors. */
function rebuildLenient(
  raw: string | undefined,
  failed: Map<string, string[]>,
): InboundPhoneMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: InboundPhoneMap = {};
  const seen = new Map<string, string>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (failed.has(k)) continue;
    if (validateEntry(v).length > 0) continue;
    const entry = v as InboundPhoneEntry;
    const key = normalize(k);
    if (!key || seen.has(key)) continue;
    seen.set(key, k);
    out[key] = { voiceId: entry.voiceId, role: entry.role };
  }
  return out;
}

const phoneMap: InboundPhoneMap = parseInboundPhoneMap(env.inboundPhoneVoiceMap);

/** Look up a per-phone override. Returns null if `to` is missing,
 *  unparseable, or not in the configured map. */
export function lookupInboundPhone(to: string | undefined): InboundPhoneEntry | null {
  if (!to) return null;
  // Inline normalize import so we don't pay an extra hop per call.
  const stripped = to.replace(/[\s\-().]/g, "");
  if (!stripped) return null;
  const key = stripped.startsWith("+") ? stripped : `+${stripped}`;
  return phoneMap[key] ?? null;
}
