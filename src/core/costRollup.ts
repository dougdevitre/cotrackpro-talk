/**
 * core/costRollup.ts — Daily cost rollup aggregation.
 *
 * Scans the DynamoDB call-records table for calls completed in a given
 * time window (default: the last 24 hours), sums the per-call cost
 * summaries, and returns a single aggregated line. The Vercel Cron
 * handler logs this as `cost.rollup.daily` so it flows into Vercel's
 * log stream alongside the existing `cost.call.summary` lines.
 *
 * Implementation notes:
 *
 *  - We reuse `listCallsByStatus("completed", ...)` which queries the
 *    `status-date-index` GSI with a startedAt range. That's the
 *    cheapest access pattern (no full-table scan) and matches the
 *    existing /records/by-status API.
 *  - Cursor pagination drains the full window — the rollup is a
 *    low-frequency operation and we want accurate totals.
 *  - The handler is idempotent: re-running for the same window
 *    produces the same numbers. No state is written anywhere.
 *  - Safety: capped at MAX_PAGES to protect the cron from running
 *    indefinitely on an unexpectedly hot day. If the cap trips we
 *    return partial results and a `truncated: true` flag so the log
 *    line is still emitted.
 */

import { listCallsByStatus } from "../services/dynamo.js";
import { logger } from "../utils/logger.js";
import type { CallRecord } from "../types/index.js";

const log = logger.child({ core: "costRollup" });

/** Hard ceiling on pages-per-rollup. 200 pages × 100 records = 20k calls. */
const MAX_PAGES = 200;
const PAGE_SIZE = 100;

export type RollupTotals = {
  callCount: number;
  totalDurationSecs: number;
  totalTurns: number;
  claudeInputTokens: number;
  claudeOutputTokens: number;
  claudeCacheCreationTokens: number;
  claudeCacheReadTokens: number;
  ttsChars: number;
  ttsCharsCached: number;
  sttSecs: number;
  estimatedCostUsd: number;
  /** Breakdown by role — useful for spotting which persona dominates spend. */
  byRole: Record<string, { callCount: number; estimatedCostUsd: number }>;
};

export type RollupResult = {
  /** ISO 8601 start of the window (inclusive). */
  windowStart: string;
  /** ISO 8601 end of the window (exclusive). */
  windowEnd: string;
  /** Aggregated totals across every completed call in the window. */
  totals: RollupTotals;
  /** True if we hit MAX_PAGES and totals are partial. */
  truncated: boolean;
  /** How many DynamoDB pages we read. */
  pagesRead: number;
};

function emptyTotals(): RollupTotals {
  return {
    callCount: 0,
    totalDurationSecs: 0,
    totalTurns: 0,
    claudeInputTokens: 0,
    claudeOutputTokens: 0,
    claudeCacheCreationTokens: 0,
    claudeCacheReadTokens: 0,
    ttsChars: 0,
    ttsCharsCached: 0,
    sttSecs: 0,
    estimatedCostUsd: 0,
    byRole: {},
  };
}

function addRecord(totals: RollupTotals, record: CallRecord): void {
  totals.callCount += 1;
  totals.totalDurationSecs += record.durationSecs ?? 0;
  totals.totalTurns += record.turnCount ?? 0;

  const cs = record.costSummary;
  if (cs) {
    totals.claudeInputTokens += cs.claudeInputTokens ?? 0;
    totals.claudeOutputTokens += cs.claudeOutputTokens ?? 0;
    totals.claudeCacheCreationTokens += cs.claudeCacheCreationTokens ?? 0;
    totals.claudeCacheReadTokens += cs.claudeCacheReadTokens ?? 0;
    totals.ttsChars += cs.ttsChars ?? 0;
    totals.ttsCharsCached += cs.ttsCharsCached ?? 0;
    totals.sttSecs += cs.sttSecs ?? 0;
    totals.estimatedCostUsd += cs.estimatedCostUsd ?? 0;
  }

  const role = record.role ?? "unknown";
  const bucket =
    totals.byRole[role] ?? (totals.byRole[role] = { callCount: 0, estimatedCostUsd: 0 });
  bucket.callCount += 1;
  bucket.estimatedCostUsd += cs?.estimatedCostUsd ?? 0;
}

/**
 * Compute a cost rollup for a time window.
 *
 * @param windowStart  ISO 8601 timestamp (inclusive).
 * @param windowEnd    ISO 8601 timestamp (exclusive).
 */
export async function computeCostRollup(
  windowStart: string,
  windowEnd: string,
): Promise<RollupResult> {
  const totals = emptyTotals();
  let lastKey: Record<string, unknown> | undefined = undefined;
  let pagesRead = 0;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await listCallsByStatus("completed", {
      startDate: windowStart,
      endDate: windowEnd,
      limit: PAGE_SIZE,
      lastKey,
    });
    pagesRead += 1;

    for (const record of result.records) {
      addRecord(totals, record);
    }

    if (!result.lastKey) {
      lastKey = undefined;
      break;
    }
    lastKey = result.lastKey;

    if (page === MAX_PAGES - 1) {
      truncated = true;
      log.warn(
        { windowStart, windowEnd, pagesRead, callCount: totals.callCount },
        "Cost rollup truncated at MAX_PAGES — increase cap or investigate traffic",
      );
    }
  }

  return {
    windowStart,
    windowEnd,
    totals,
    truncated,
    pagesRead,
  };
}

/**
 * Convenience wrapper for "yesterday" — returns a rollup for the last
 * 24 hours ending now. Used by the default daily cron schedule.
 */
export function last24Hours(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}
