/**
 * core/callCompletion.ts — Pure helpers for finalizing a call on
 * disconnect.
 *
 * The `cleanup()` path in `src/handlers/callHandler.ts` runs when a
 * Twilio WebSocket closes. It has to:
 *
 *   1. Turn the live `CallSession.conversationHistory` (a mix of
 *      string-content turns and structured-block turns for tool
 *      use) into a flat `TranscriptEntry[]` suitable for the
 *      DynamoDB call record.
 *   2. Compute a cost summary from the running `costMetrics` on
 *      the session.
 *   3. Persist both to DynamoDB (fire-and-forget; failures are
 *      logged but don't prevent the call from ending).
 *
 * Items 1 and 2 are pure functions of the session state with no
 * side effects. Extracting them here makes them directly unit-
 * testable without having to stand up the whole WebSocket handler
 * or mock DynamoDB. The DynamoDB writes themselves stay in the
 * handler's `cleanup()` because they're IO that needs access to
 * the handler's logger + error-handling policy.
 *
 * Pass 3 of the E-6/A-6 callHandler.ts refactor arc.
 */

import type {
  CallSession,
  CallCostSummary,
  TranscriptEntry,
} from "../types/index.js";
import { estimateCallCost } from "../utils/costEstimator.js";

/**
 * Build the finalized transcript array from a live
 * `CallSession.conversationHistory`.
 *
 * Behavior (preserved from the pre-refactor inline code):
 *
 *   - Only string-content turns are included. Structured-block
 *     turns (assistant tool_use, user tool_result) are dropped
 *     from the transcript because they aren't human-readable and
 *     the dashboard / records reader expects plain text.
 *   - Each entry's `timestamp` is converted from epoch ms to an
 *     ISO 8601 string for DynamoDB compatibility.
 *
 * Pure function — safe to call repeatedly, no side effects on
 * the session.
 */
export function buildCompletedTranscript(
  session: CallSession,
): TranscriptEntry[] {
  return session.conversationHistory
    .filter((t) => typeof t.content === "string")
    .map((t) => ({
      role: t.role,
      text: t.content as string,
      timestamp: new Date(t.timestamp).toISOString(),
    }));
}

/**
 * Compute wall-clock duration (in whole seconds) of a call, from
 * `session.createdAt` to `now`. Exported as a separate helper
 * because a few callers want the number without the full
 * completion bundle.
 */
export function computeDurationSecs(
  session: CallSession,
  now: number = Date.now(),
): number {
  return Math.round((now - session.createdAt) / 1000);
}

/**
 * The full completion bundle a caller needs to persist a call
 * record. Computed by `finalizeCallCompletion` from a session's
 * live state.
 */
export interface CallCompletionBundle {
  /** Wall-clock duration in whole seconds. */
  durationSecs: number;
  /** Count of human-readable transcript turns (matches
   *  `transcript.length` — duplicated for operator convenience). */
  turnCount: number;
  /** ISO 8601 completion timestamp. Computed from `now`. */
  endedAt: string;
  /** Flat human-readable transcript, ready for DynamoDB. */
  transcript: TranscriptEntry[];
  /** Finalized cost summary, ready for DynamoDB + the
   *  `cost.call.summary` structured log line. */
  costSummary: CallCostSummary;
}

/**
 * Compute everything needed to finalize a completed call: duration,
 * transcript, cost summary. Pure function.
 *
 * The caller (currently `handleCallStream.cleanup()`) is
 * responsible for the actual DynamoDB writes and the
 * `cost.call.summary` log line, because those need access to the
 * handler's logger and error-handling policy. Keeping the
 * IO side-effects out of this file means it's trivial to unit
 * test with in-memory session fixtures.
 */
export function finalizeCallCompletion(
  session: CallSession,
  now: number = Date.now(),
): CallCompletionBundle {
  const durationSecs = computeDurationSecs(session, now);
  const transcript = buildCompletedTranscript(session);
  const turnCount = transcript.length;
  const endedAt = new Date(now).toISOString();
  const costSummary = estimateCallCost(session.costMetrics);
  return { durationSecs, turnCount, endedAt, transcript, costSummary };
}
