/**
 * core/smsConversation.ts — Conversational inbound SMS.
 *
 * Before this module, every non-keyword inbound text was reduced to its
 * FIRST WORD and forwarded to the hub as `{ phone, keyword }`. The hub is
 * keyword-routed, so "he showed up two hours late again and the kids were
 * upset" became the keyword "he" and came back as a generic menu. The
 * body was discarded. Texting the line was a vending machine, not a
 * conversation.
 *
 * This module gives the SMS channel the same brain the phone line has:
 * Claude, the same trauma-informed CoTrackPro persona (shared with the
 * voice path via `getRoleAddendum`), and short-term memory of the thread
 * so follow-up texts land in context.
 *
 * WHAT STAYS THE SAME (deliberately):
 *   - STOP / START / HELP are still handled by src/core/consent.ts before
 *     this module is ever consulted. Carrier compliance is not delegated
 *     to a model.
 *   - The hub's structured commands (CONFIRM, SNOOZE, DEADLINES, LOG,
 *     RESOURCES, SAFE) still route to the hub. Those are state-changing
 *     operations on the user's record; a conversational paraphrase of
 *     them would be worse, not better.
 *   - Everything else — free text — now gets a real reply.
 *
 * MEMORY: the last few turns are held in the KV store under a SHA-256
 * hash of the sender's number (never the raw number), with a short TTL
 * (SMS_THREAD_TTL_SECONDS, default 1h). A thread that goes quiet expires
 * on its own; STOP clears it immediately.
 *
 * COST: replies are capped at SMS_REPLY_MAX_CHARS and each sender gets a
 * per-minute/per-hour budget, so a flood against the published number
 * can't amplify into unbounded Anthropic + Twilio spend.
 *
 * PII: this module never logs the raw phone number or the message body —
 * only the hashed thread id, turn counts, and token usage.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { kv } from "../services/kv.js";
import { getRoleAddendum } from "../services/anthropic.js";
import { appendFooterOnce } from "./consent.js";
import { checkRateLimit } from "./rateLimit.js";

const log = logger.child({ core: "smsConversation" });

// ── Hub-routed structured commands ────────────────────────────────────────────

/**
 * First words that belong to the hub's keyword router, not to the model.
 * These mutate or read the user's record (confirm a reminder, snooze it,
 * list deadlines, log an entry, pull resources), and the hub owns that
 * state. A conversational rewrite of these would be a regression.
 *
 * Matched case-insensitively on the FIRST token only, punctuation
 * stripped — same rule as `classifyKeyword` in core/consent.ts, so
 * "confirm." and "  CONFIRM  " both route to the hub.
 */
const HUB_COMMAND_WORDS = new Set([
  "RESOURCES",
  "SAFE",
  "DEADLINES",
  "LOG",
  "CONFIRM",
  "SNOOZE",
  "MENU",
]);

/** Whether this inbound body is a structured hub command (not free text). */
export function isHubCommand(body: string | undefined): boolean {
  if (!body) return false;
  const first = body.trim().split(/\s+/)[0] ?? "";
  const word = first.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (!word) return false;
  return HUB_COMMAND_WORDS.has(word);
}

// ── Crisis detection ──────────────────────────────────────────────────────────

/**
 * Local, model-independent crisis screen.
 *
 * The system prompt already instructs Claude to surface crisis resources,
 * but "the model was told to" is not a safety guarantee — a truncated
 * generation, a timeout, or an unlucky sample could drop the hotline. So
 * we detect the highest-risk language ourselves and GUARANTEE the numbers
 * appear in the outgoing message (see `ensureCrisisResources`). Belt and
 * braces, on the one path where being wrong is unacceptable.
 *
 * Deliberately high-recall and low-precision: an unnecessary hotline line
 * in a reply costs a few characters; a missing one can cost far more.
 */
const CRISIS_PATTERNS: RegExp[] = [
  /\bkill (myself|me)\b/i,
  /\bkilling myself\b/i,
  /\b(want|going|plan) to die\b/i,
  /\bend (my life|it all)\b/i,
  /\bsuicid/i,
  /\bhurt (myself|my ?self)\b/i,
  /\bharm(ing)? myself\b/i,
  /\bself[- ]harm/i,
  /\b(he|she|they|dad|mom|father|mother) (is |'s )?(hitting|beating|choking|strangling|hurting)\b/i,
  /\b(gun|knife|weapon)\b/i,
  /\b(being|getting) (hit|beaten|abused|assaulted)\b/i,
  /\bnot safe (right now|here|tonight)\b/i,
  /\bin danger\b/i,
  /\bhelp me\b.*\b(now|please)\b/i,
];

/** Whether the inbound text reads as an active-crisis disclosure. */
export function detectCrisis(body: string | undefined): boolean {
  if (!body) return false;
  return CRISIS_PATTERNS.some((re) => re.test(body));
}

/** The resource line we guarantee on a crisis-flagged exchange. */
export const CRISIS_RESOURCE_LINE =
  "If you're in immediate danger call 911. For 24/7 crisis support call or text 988.";

/**
 * Append the crisis resource line unless the reply already carries the
 * numbers. Checks for the digits themselves rather than the exact phrasing
 * so a naturally-worded model reply ("you can reach 988 anytime") isn't
 * followed by a redundant duplicate.
 */
export function ensureCrisisResources(reply: string): string {
  if (/\b988\b/.test(reply) && /\b911\b/.test(reply)) return reply;
  return `${reply.trimEnd()}\n\n${CRISIS_RESOURCE_LINE}`;
}

// ── System prompt ─────────────────────────────────────────────────────────────

/**
 * SMS-channel rules layered on top of the shared role persona. The voice
 * prompt's channel rules ("you are on a phone call", "no formatting")
 * don't transfer — texting has different physics: the recipient can
 * re-read, can't be interrupted, and pays per segment.
 */
const SMS_CHANNEL_PROMPT = `You are the CoTrackPro assistant replying over SMS text message — \
a child-centered, trauma-informed documentation and safety service.

TEXTING STYLE:
- Write like a real person texting, not like a form letter or an automated menu.
- 1 to 3 short sentences. Under 320 characters unless the person asked for something
  that genuinely needs more.
- Plain text only. No markdown, no asterisks, no bullet points, no numbered lists,
  no headers, no emoji.
- One idea per message. If there's more to cover, offer it: "Want me to walk through that?"
- Ask at most one question per message.
- Never open with "Thank you for contacting CoTrackPro" or any canned greeting.
  Answer the person in front of you.
- Don't re-introduce yourself on every message — this is an ongoing thread.
- Never say you'll "get back to them", "look into it", or "have someone follow up".
  You are the one replying, right now.

TONE:
- Calm, warm, practical. Validate before solving.
- Court-neutral: factual and objective. Describe behavior, never characterize a person.
- Educational only for legal or clinical content; for anything that turns on legal
  strategy, add briefly: "For legal advice, talk to a licensed attorney."
- Never fabricate statutes, case citations, deadlines, or clinical standards.
- Never repeat back full names, addresses, or case numbers.

WHAT YOU CAN DO:
- Help them document an incident factually (what happened, when, who was present).
- Help de-escalate a co-parenting message before they send it.
- Help organize a timeline or prepare for court.
- Talk through what they're dealing with.
If they want to document something, offer to capture it and confirm the facts back
in one short sentence.

CRISIS:
- Immediate danger (someone being hurt now, weapons present): tell them to call 911.
- Self-harm, suicidal thoughts, recent abuse disclosure: acknowledge it first
  ("Thank you for telling me — that took courage"), then give 988 (call or text)
  and the Crisis Text Line (text HOME to 741741). For child abuse concerns:
  1-800-422-4453.
- Never minimize, never ask if they're sure, never ask them to re-describe the details.

LANGUAGE TO NEVER USE:
- "Both sides of the story" / "there are two sides"
- "High conflict" to describe the person texting you
- "Parental alienation" as a diagnosis or framework
- "Just communicate better" / "you need to co-parent better"
- "Are you sure that happened?" / "could you be misremembering?"
- "Calm down" / "it's not that bad" / "at least..." / "for the sake of the children"
- "You should forgive" / "move on" / "let it go"

CHANNEL LIMITS:
- This is SMS. Never claim you sent an email, opened a file, or attached a document.
- If something needs the full app, say so plainly and briefly.
- Don't ask them to reply with a keyword unless it is STOP or HELP.`;

/** Build the full SMS system prompt for a role. */
export function buildSmsSystemPrompt(role: string): string {
  return SMS_CHANNEL_PROMPT + "\n" + getRoleAddendum(role);
}

// ── Thread memory ─────────────────────────────────────────────────────────────

export interface SmsTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Max turns kept per thread (user + assistant entries combined). Long
 * enough to hold a real exchange, short enough that a resumed thread
 * can't grow the prompt without bound.
 */
export const MAX_THREAD_TURNS = 12;

/**
 * KV key for a sender's thread. SHA-256 (truncated to 128 bits) of the
 * E.164 number, for the same reason core/consent.ts hashes suppression
 * keys: the raw subscriber number must never land in a Redis key name,
 * and a collision here would cross two people's conversations.
 */
function threadKey(phone: string): string {
  const h = createHash("sha256").update(phone).digest("hex").slice(0, 32);
  return `sms:conv:${h}`;
}

/** Short, non-reversible thread id for log lines (never the raw number). */
export function threadId(phone: string): string {
  return createHash("sha256").update(phone).digest("hex").slice(0, 12);
}

/**
 * Load a sender's recent turns. Fails OPEN (empty thread) on any KV or
 * parse error — losing context degrades the reply, but refusing to reply
 * because Redis hiccupped would be worse.
 */
export async function loadThread(phone: string): Promise<SmsTurn[]> {
  try {
    const raw = await kv().get(threadKey(phone));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is SmsTurn =>
          !!t &&
          typeof t === "object" &&
          ((t as SmsTurn).role === "user" || (t as SmsTurn).role === "assistant") &&
          typeof (t as SmsTurn).content === "string",
      )
      .slice(-MAX_THREAD_TURNS);
  } catch {
    return [];
  }
}

/**
 * Persist a thread, trimmed to the most recent turns and always starting
 * on a user turn (the Anthropic API rejects a leading assistant message).
 * Best-effort: a failed write costs context on the next message, nothing
 * more, so it never propagates to the caller.
 */
export async function saveThread(phone: string, turns: SmsTurn[]): Promise<void> {
  let trimmed = turns.slice(-MAX_THREAD_TURNS);
  while (trimmed.length > 0 && trimmed[0]!.role !== "user") {
    trimmed = trimmed.slice(1);
  }
  try {
    await kv().set(
      threadKey(phone),
      JSON.stringify(trimmed),
      env.smsThreadTtlSeconds,
    );
  } catch (err) {
    log.warn({ err, thread: threadId(phone) }, "Failed to persist SMS thread");
  }
}

/** Drop a sender's thread. Called on STOP so an opt-out leaves nothing behind. */
export async function clearThread(phone: string): Promise<void> {
  try {
    await kv().delete(threadKey(phone));
  } catch {
    /* best-effort */
  }
}

// ── Reply shaping ─────────────────────────────────────────────────────────────

/**
 * Strip formatting the model shouldn't have emitted and clamp the reply
 * to a segment budget.
 *
 * Truncation prefers a sentence boundary inside the last quarter of the
 * budget, so a clipped reply reads as a finished thought rather than a
 * severed one. Only if there's no usable boundary do we hard-cut and
 * ellipsize.
 */
export function shapeForSms(text: string, maxChars = env.smsReplyMaxChars): string {
  let out = text
    // Markdown emphasis / headers / code fences the SMS channel can't render.
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`#]+/g, "")
    // Bullet or numbered list markers at line starts → inline sentences.
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    // Collapse runs of blank lines; SMS clients render them as dead space.
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  if (out.length <= maxChars) return out;

  const window = out.slice(0, maxChars);
  const lastBoundary = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
    window.lastIndexOf(".\n"),
    window.lastIndexOf("?\n"),
    window.lastIndexOf("!\n"),
  );
  if (lastBoundary > maxChars * 0.6) {
    return window.slice(0, lastBoundary + 1).trim();
  }
  return `${window.slice(0, maxChars - 1).trimEnd()}…`;
}

// ── Anthropic seam ────────────────────────────────────────────────────────────

export interface SmsCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type SmsCompleter = (args: {
  system: string;
  messages: SmsTurn[];
  maxTokens: number;
  signal: AbortSignal;
}) => Promise<SmsCompletion>;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: env.anthropicApiKey });
  return _client;
}

const realCompleter: SmsCompleter = async ({ system, messages, maxTokens, signal }) => {
  const msg = await client().messages.create(
    {
      model: env.anthropicModel,
      max_tokens: maxTokens,
      // Cached as one stable prefix keyed by role — the persona block is
      // ~4k tokens and identical on every message from every sender.
      system: [
        {
          type: "text",
          text: system,
          cache_control: { type: "ephemeral" },
        } as Anthropic.TextBlockParam,
      ],
      messages: messages.map((t) => ({ role: t.role, content: t.content })),
    },
    { signal },
  );
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    text,
    inputTokens: msg.usage.input_tokens ?? 0,
    outputTokens: msg.usage.output_tokens ?? 0,
  };
};

let _completerImpl: SmsCompleter | null = null;
/** Test-only: inject a completion stub. Do not call in production. */
export function _setSmsCompleterForTests(impl: SmsCompleter | null): void {
  _completerImpl = impl;
}
function completer(): SmsCompleter {
  return _completerImpl ?? realCompleter;
}

// ── Static fallbacks ──────────────────────────────────────────────────────────

/**
 * Sent when Claude is unreachable, times out, or returns nothing. Still
 * conversational, still carries the safety floor — the person texted a
 * crisis-adjacent service and deserves better than a stack trace.
 */
export const SMS_FALLBACK_REPLY =
  "I'm here, but I couldn't process that just now. Try me again in a moment. " +
  "If this is an emergency call 911, and for 24/7 crisis support call or text 988.";

/** Sent when a sender exceeds their per-window budget. */
export const SMS_RATE_LIMITED_REPLY =
  "I'm getting your messages faster than I can answer. Give me a minute and " +
  "send that again. If this is an emergency call 911, or call or text 988 for crisis support.";

// ── Main entry point ──────────────────────────────────────────────────────────

export type SmsReplySource = "ai" | "fallback" | "rate_limited";

export interface SmsReplyResult {
  /** The message to send back, already shaped, footered, and safe to TwiML. */
  text: string;
  source: SmsReplySource;
  /** True when this was the first exchange in a fresh thread. */
  firstTurn: boolean;
}

/**
 * Produce a conversational reply to an inbound text.
 *
 * The caller is responsible for having already handled STOP/START/HELP
 * and hub commands — this function assumes it's looking at free text.
 *
 * The opt-out footer is appended on the FIRST reply of a thread only.
 * Repeating it on every message of a live back-and-forth burns a segment
 * per turn and reads as machine noise; the carrier requirement is that
 * opt-out instructions be present and discoverable, and HELP/STOP remain
 * honored on every single message regardless.
 */
export async function generateSmsReply(params: {
  from: string;
  body: string;
  role?: string;
}): Promise<SmsReplyResult> {
  const { from, body } = params;
  const role = params.role ?? "parent";
  const tid = threadId(from);
  const crisis = detectCrisis(body);

  // Per-sender budget. Keyed on the hashed thread id so the raw number
  // never reaches a rate-limit key either.
  const limit = await checkRateLimit(tid, "smsai", {
    perMinute: env.smsAiRateLimitPerMin,
    perHour: env.smsAiRateLimitPerHour,
  });
  if (!limit.allowed) {
    log.warn({ thread: tid, limitedBy: limit.limitedBy }, "Inbound SMS AI rate-limited");
    return {
      text: crisis
        ? ensureCrisisResources(SMS_RATE_LIMITED_REPLY)
        : SMS_RATE_LIMITED_REPLY,
      source: "rate_limited",
      firstTurn: false,
    };
  }

  const prior = await loadThread(from);
  const firstTurn = prior.length === 0;
  const messages: SmsTurn[] = [...prior, { role: "user", content: body }];

  let system = buildSmsSystemPrompt(role);
  if (crisis) {
    // Hoisted to the end of the system prompt so it's the last instruction
    // the model reads before generating.
    system +=
      "\n\nTHIS MESSAGE HAS BEEN FLAGGED AS A POSSIBLE ACTIVE CRISIS. " +
      "Acknowledge what they said first, in one sentence, without questioning it. " +
      "Then give the relevant resource: 911 for immediate danger, 988 (call or text) " +
      "for crisis support. Keep it short and steady. Do not ask them to re-describe " +
      "what happened.";
  }

  const started = Date.now();
  const abort = AbortSignal.timeout(env.smsAiTimeoutMs);
  try {
    const completion = await completer()({
      system,
      messages,
      maxTokens: env.smsReplyMaxTokens,
      signal: abort,
    });

    const shaped = shapeForSms(completion.text);
    if (!shaped) throw new Error("empty completion");

    const withCrisis = crisis ? ensureCrisisResources(shaped) : shaped;
    const text = firstTurn ? appendFooterOnce(withCrisis) : withCrisis;

    // Persist the SHAPED assistant turn (what the person actually
    // received) — not the raw completion — so the thread the model sees
    // next turn matches the thread the human sees.
    await saveThread(from, [...messages, { role: "assistant", content: withCrisis }]);

    log.info(
      {
        thread: tid,
        role,
        crisis,
        firstTurn,
        turns: messages.length,
        latencyMs: Date.now() - started,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        replyChars: text.length,
      },
      "sms.ai.reply",
    );

    return { text, source: "ai", firstTurn };
  } catch (err) {
    const timedOut = abort.aborted || (err instanceof Error && err.name === "AbortError");
    log.error(
      { err, thread: tid, timeout: timedOut, latencyMs: Date.now() - started },
      timedOut ? "sms.ai.timeout" : "sms.ai.error",
    );
    const fallback = crisis
      ? ensureCrisisResources(SMS_FALLBACK_REPLY)
      : SMS_FALLBACK_REPLY;
    return {
      text: firstTurn ? appendFooterOnce(fallback) : fallback,
      source: "fallback",
      firstTurn,
    };
  }
}
