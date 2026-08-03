/**
 * src/audio/greetings.ts
 *
 * The exact words every caller hears first. This is the single source of truth:
 * the live call handler reads it, and scripts/generate-prerecorded.ts renders the
 * same strings to cached audio. Previously the two kept separate copies, which
 * meant an edit in one place could silently not reach callers.
 *
 * Every greeting opens with a disclosure because the call is transcribed and
 * persisted (see core/callCompletion.ts and services/dynamo.ts). Recording a
 * conversation without telling the caller is a wiretap question in two-party
 * consent states, and this product is used in family-crisis contexts where the
 * stakes of getting that wrong are high. The disclosure is a fixed string, not
 * an instruction to the model, so it cannot be skipped or paraphrased away.
 *
 * If you change this file, re-run `npm run generate-audio` — otherwise the
 * cached audio keeps playing the previous wording.
 */

import type { CoTrackProRole } from "../types/index.js";

/**
 * Spoken to adult callers before anything else.
 *
 * Two facts, in the order that matters to someone deciding whether to keep
 * talking: this is being written down, and it is not professional advice.
 */
export const TRANSCRIPTION_NOTICE =
  "Before we begin: this call is transcribed and saved to the CoTrackPro " +
  "account it belongs to, and what I share is educational information, " +
  "not legal or clinical advice.";

/**
 * Spoken to callers on the kid/teen line.
 *
 * Same two facts, said plainly. A minor is the least likely caller to assume a
 * help line is being recorded and the most affected by finding out later, so
 * this states that the transcript is not private rather than implying it.
 */
export const TRANSCRIPTION_NOTICE_KID_TEEN =
  "Before we start, two things you should know. What we talk about gets " +
  "written down and saved to this CoTrackPro account, so it isn't only " +
  "between us. And I'm not a lawyer or a counselor — I'm here to listen and " +
  "help you think things through.";

const DEFAULT_BODY =
  "Welcome to CoTrack Pro. I'm here to help with documentation, " +
  "safety planning, and co-parenting support. " +
  "How can I help you today?";

/** Role-specific body, spoken after the disclosure. */
const GREETING_BODIES: Partial<Record<CoTrackProRole, string>> = {
  kid_teen:
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
};

/**
 * The complete greeting for a role: disclosure first, then the role body.
 *
 * A role with no entry in GREETING_BODIES still gets the disclosure, so adding
 * a role to CoTrackProRole can never ship an undisclosed line.
 */
export function getRoleGreeting(role: CoTrackProRole): string {
  const notice =
    role === "kid_teen" ? TRANSCRIPTION_NOTICE_KID_TEEN : TRANSCRIPTION_NOTICE;
  const body = GREETING_BODIES[role] ?? DEFAULT_BODY;
  return `${notice} ${body}`;
}
