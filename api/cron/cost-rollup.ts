/**
 * api/cron/cost-rollup.ts — Vercel Cron handler for daily cost rollup.
 *
 * Runs on a schedule configured in vercel.json. Reads completed call
 * records from DynamoDB for the last 24 hours, aggregates per-call
 * cost summaries via src/core/costRollup.ts, and emits a single
 * structured log line (`cost.rollup.daily`) so the totals flow into
 * Vercel's log stream alongside the existing per-call
 * `cost.call.summary` lines.
 *
 * Auth: Vercel Cron sends an `Authorization: Bearer ${CRON_SECRET}`
 * header when a request comes from the cron dispatcher. We reject
 * any other caller (including direct attempts to hit
 * /api/cron/cost-rollup with a browser or curl) so the endpoint
 * can't be used to amplify read load on DynamoDB.
 *
 * Reference:
 *   https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  computeCostRollup,
  last24Hours,
  type RollupResult,
} from "../../src/core/costRollup.js";
import { requireMethod, sendJson } from "../../src/core/httpAdapter.js";
import { bearerMatches } from "../../src/core/auth.js";
import { env } from "../../src/config/env.js";
import { logger } from "../../src/utils/logger.js";

const log = logger.child({ cron: "cost-rollup" });

/**
 * Verify the caller is Vercel Cron. Returns true on success, or
 * false + writes a response on failure (so the caller can early-
 * return).
 *
 * The check is skipped entirely when CRON_SECRET is unset. That's a
 * deliberate escape hatch for local development: you can hit the
 * endpoint with `curl http://localhost:3000/api/cron/cost-rollup`
 * to test the rollup logic without faking a Bearer token. In
 * production CRON_SECRET must be set.
 */
function authorizeCron(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!env.cronSecret) {
    log.warn(
      "CRON_SECRET is unset — cron handler is unauthenticated. Set CRON_SECRET in production.",
    );
    return true;
  }
  if (!bearerMatches(req.headers.authorization, env.cronSecret)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Vercel Cron issues GET requests. We accept GET only so a stray
  // POST can't trigger a rollup.
  if (!requireMethod(req, res, "GET")) return;
  if (!authorizeCron(req, res)) return;

  const { start, end } = last24Hours();

  log.info({ windowStart: start, windowEnd: end }, "cost.rollup.starting");

  let result: RollupResult;
  try {
    result = await computeCostRollup(start, end);
  } catch (err) {
    log.error(
      { err, windowStart: start, windowEnd: end },
      "cost.rollup.failed",
    );
    sendJson(res, 500, {
      error: "Rollup failed",
      details: err instanceof Error ? err.message : "unknown",
    });
    return;
  }

  // Emit the canonical rollup line. A CloudWatch / Vercel log metric
  // filter on `cost.rollup.daily` plots these as a time series.
  log.info(
    {
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      pagesRead: result.pagesRead,
      truncated: result.truncated,
      callCount: result.totals.callCount,
      totalDurationSecs: result.totals.totalDurationSecs,
      totalTurns: result.totals.totalTurns,
      claudeInputTokens: result.totals.claudeInputTokens,
      claudeOutputTokens: result.totals.claudeOutputTokens,
      claudeCacheCreationTokens: result.totals.claudeCacheCreationTokens,
      claudeCacheReadTokens: result.totals.claudeCacheReadTokens,
      ttsChars: result.totals.ttsChars,
      ttsCharsCached: result.totals.ttsCharsCached,
      sttSecs: result.totals.sttSecs,
      estimatedCostUsd: result.totals.estimatedCostUsd,
      byRole: result.totals.byRole,
    },
    "cost.rollup.daily",
  );

  // Return the same structure as the log line so a human can curl
  // the endpoint for a live rollup if needed.
  sendJson(res, 200, {
    ok: true,
    windowStart: result.windowStart,
    windowEnd: result.windowEnd,
    pagesRead: result.pagesRead,
    truncated: result.truncated,
    totals: result.totals,
  });
}
