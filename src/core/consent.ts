/**
 * core/consent.ts — SMS keyword classification + suppression list.
 *
 * The talk edge owns the Twilio number, so it must honor the carrier
 * STOP/HELP/START contract directly on inbound SMS (api/sms/incoming.ts):
 *
 *   - STOP / UNSUBSCRIBE / CANCEL / END / QUIT → opt OUT: add the number
 *     to the suppression list so no further SMS goes out, and tell the
 *     hub to record consent = opted_out.
 *   - START / UNSTOP → opt back IN: remove the suppression, record
 *     consent = opted_in.
 *   - HELP / INFO → static help reply, no state change.
 *   - anything else → not a keyword; forward to the hub.
 *
 * The suppression list is also read on the OUTBOUND path
 * (src/core/sms.ts, src/core/voiceOutbound.ts): a suppressed number is
 * never texted or called, regardless of what the hub asks for.
 *
 * Storage: the KV store, keyed by a hash of the phone number so the raw
 * PII never lands in a Redis key name. Suppression entries have no TTL —
 * an opt-out is durable until the user explicitly opts back in.
 *
 * PII: this module never logs the raw phone number or message body.
 */

import { kv } from "../services/kv.js";
import { hashClientKey } from "./rateLimit.js";

export type SmsKeyword = "stop" | "start" | "help";

/** Carrier-standard opt-out keywords (Twilio Advanced Opt-Out set). */
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
/** Opt-back-in keywords. */
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);
/** Help keywords. */
const HELP_WORDS = new Set(["HELP", "INFO"]);

/**
 * The canonical opt-out footer the talk edge appends to messages IT
 * composes (inbound replies). Outbound hub bodies already carry their
 * own footer and are pre-capped, so we must NOT add this there.
 */
export const OPT_OUT_FOOTER = "Reply STOP to unsubscribe, HELP for help.";

/** Static reply sent when a number opts out via STOP. */
export const STOP_REPLY =
  "You're unsubscribed from CoTrackPro reminders and won't receive more " +
  "messages. Reply START to resubscribe.";

/** Static reply sent when a number opts back in via START. */
export const START_REPLY =
  "You're resubscribed to CoTrackPro reminders. " + OPT_OUT_FOOTER;

/** Static reply sent for HELP/INFO. */
export const HELP_REPLY =
  "CoTrackPro sends reminders for your CoTrackPro account. " +
  "Msg&data rates may apply. " +
  OPT_OUT_FOOTER;

/**
 * Classify an inbound SMS body as a carrier keyword, or null if it's a
 * normal message to forward. Keywords are matched case-insensitively
 * against the FIRST whitespace-trimmed token with surrounding
 * punctuation stripped, so "Stop.", "  STOP  ", and "stop please" all
 * classify as stop — matching carrier behavior.
 */
export function classifyKeyword(body: string | undefined): SmsKeyword | null {
  if (!body) return null;
  // First token only; strip leading/trailing non-letters.
  const first = body.trim().split(/\s+/)[0] ?? "";
  const word = first.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (!word) return null;
  if (STOP_WORDS.has(word)) return "stop";
  if (START_WORDS.has(word)) return "start";
  if (HELP_WORDS.has(word)) return "help";
  return null;
}

/**
 * Append the canonical opt-out footer to a talk-composed reply, but only
 * if it isn't already present — so a hub reply that already includes the
 * footer doesn't end up with two. Comparison ignores case/whitespace.
 */
export function appendFooterOnce(body: string): string {
  const trimmed = body.trimEnd();
  const haystack = trimmed.toLowerCase().replace(/\s+/g, " ");
  const needle = OPT_OUT_FOOTER.toLowerCase().replace(/\s+/g, " ");
  if (haystack.includes(needle)) return trimmed;
  return `${trimmed}\n\n${OPT_OUT_FOOTER}`;
}

// ── Suppression list ──────────────────────────────────────────────────────────

function suppressionKey(phone: string): string {
  return `sms:stop:${hashClientKey(phone)}`;
}

/** Whether this number has opted out. Fails OPEN-CLOSED-safe: on a KV
 *  error we treat the number as NOT suppressed so we don't silently drop
 *  a legitimate auth/reminder send — but we surface nothing to the
 *  caller beyond the boolean. */
export async function isSuppressed(phone: string): Promise<boolean> {
  try {
    return (await kv().get(suppressionKey(phone))) !== null;
  } catch {
    return false;
  }
}

/** Add a number to the suppression list (opt-out). Durable, no TTL. */
export async function suppress(phone: string): Promise<void> {
  await kv().set(suppressionKey(phone), "1");
}

/** Remove a number from the suppression list (opt back in). */
export async function unsuppress(phone: string): Promise<void> {
  await kv().delete(suppressionKey(phone));
}
