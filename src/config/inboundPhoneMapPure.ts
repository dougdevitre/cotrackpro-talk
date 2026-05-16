/**
 * config/inboundPhoneMapPure.ts — Pure parser + validator for
 * INBOUND_PHONE_VOICE_MAP. Zero coupling to env or logger so the
 * pre-deploy lint script can run before any prod secrets are present.
 *
 * The runtime cached path (parseInboundPhoneMap, lookupInboundPhone)
 * lives in inboundPhoneMap.ts and is built on top of these helpers.
 */

import type { CoTrackProRole } from "../types/index.js";
import { isValidRole } from "../core/roleSet.js";
import { isValidVoiceId } from "../core/voiceIdFormat.js";

export interface InboundPhoneEntry {
  voiceId: string;
  role: CoTrackProRole;
}

export type InboundPhoneMap = Record<string, InboundPhoneEntry>;

export interface InboundPhoneMapError {
  /** Phone key from the source JSON (raw, pre-normalization) if the
   *  error is per-entry. Absent for top-level JSON / shape errors. */
  key?: string;
  message: string;
}

export type ValidateResult =
  | { ok: true; map: InboundPhoneMap }
  | { ok: false; errors: InboundPhoneMapError[] };

/** Strip whitespace/punctuation and ensure leading "+", so "13143948500",
 *  "+1 314 394 8500", and "+13143948500" all collapse to the same key. */
export function normalize(num: string): string {
  const stripped = num.replace(/[\s\-().]/g, "");
  if (!stripped) return "";
  return stripped.startsWith("+") ? stripped : `+${stripped}`;
}

/** Inspect one map entry; return human-readable reasons it's invalid
 *  (empty array means valid). Shared between the lenient runtime
 *  parser and the strict validator so both walk identical rules. */
export function validateEntry(v: unknown): string[] {
  const reasons: string[] = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    reasons.push("Entry must be a JSON object");
    return reasons;
  }
  const entry = v as Partial<InboundPhoneEntry>;
  if (typeof entry.voiceId !== "string") {
    reasons.push("Missing or non-string voiceId");
  } else if (!isValidVoiceId(entry.voiceId)) {
    reasons.push(
      `voiceId ${JSON.stringify(entry.voiceId)} failed format check (expected 16-32 alphanumeric chars)`,
    );
  }
  if (typeof entry.role !== "string") {
    reasons.push("Missing or non-string role");
  } else if (!isValidRole(entry.role)) {
    reasons.push(`role ${JSON.stringify(entry.role)} is not in VALID_ROLES`);
  }
  return reasons;
}

/** Strict validator used by `npm run lint:config`. Returns structured
 *  errors instead of warn-and-skip. Empty/undefined input is a valid
 *  state (no overrides configured) and returns ok:true. */
export function validateInboundPhoneMap(raw: string | undefined): ValidateResult {
  if (!raw) return { ok: true, map: {} };
  const errors: InboundPhoneMapError[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    errors.push({ message: `Invalid JSON: ${(err as Error).message}` });
    return { ok: false, errors };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push({ message: "Top-level value must be a JSON object" });
    return { ok: false, errors };
  }

  const out: InboundPhoneMap = {};
  // Track normalized keys we've already seen so we can flag collisions
  // (e.g. "+13143948500" and "13143948500" both normalize to the same
  // canonical key — silent overwrite is exactly the kind of typo this
  // validator exists to catch).
  const seen = new Map<string, string>();

  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const issues = validateEntry(v);
    if (issues.length > 0) {
      for (const m of issues) errors.push({ key: k, message: m });
      continue;
    }
    const entry = v as InboundPhoneEntry;
    const key = normalize(k);
    if (!key) {
      errors.push({ key: k, message: "Phone key normalized to empty string" });
      continue;
    }
    if (seen.has(key)) {
      errors.push({
        key: k,
        message: `Phone key collides with "${seen.get(key)}" after normalization (both → ${key})`,
      });
      continue;
    }
    seen.set(key, k);
    out[key] = { voiceId: entry.voiceId, role: entry.role };
  }

  return errors.length ? { ok: false, errors } : { ok: true, map: out };
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

/** Lenient parser that drops bad entries silently. Pure (no logger,
 *  no env), so operator scripts can run before prod secrets are
 *  present. The runtime path in inboundPhoneMap.ts wraps this with
 *  warn-emitting behavior. */
export function parseInboundPhoneMapLenient(raw: string | undefined): InboundPhoneMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: InboundPhoneMap = {};
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (validateEntry(v).length > 0) continue;
    const entry = v as InboundPhoneEntry;
    const key = normalize(k);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out[key] = { voiceId: entry.voiceId, role: entry.role };
  }
  return out;
}
