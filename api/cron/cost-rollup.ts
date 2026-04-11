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
import {
  requireMethod,
  sendJson,
  stampRequestId,
} from "../../src/core/httpAdapter.js";
import { bearerMatches } from "../../src/core/auth.js";
import { env } from "../../src/config/env.js";
import { logger } from "../../src/utils/logger.js";

const log = logger.child({ cron: "cost-rollup" });

/**
 * Verify the caller is Vercel Cron. Returns true on success, or
 * false + writes a response on failure (so the caller can early-
 * return).
 *
 * Behavior when CRON_SECRET is unset:
 *
 *   - NODE_ENV === "production" → **fail-closed 500**. Unsetting the
 *     secret in prod is a misconfiguration that would turn the
 *     endpoint into an unauthenticated DynamoDB-scan amplifier for
 *     anyone on the internet. We refuse to run rather than warn.
 *     (Audit E-3 in docs/CODE_REVIEW-vercel-hosting-optimization.md.)
 *
 *   - Any other NODE_ENV → permit unauthenticated calls with a
 *     warning log. Lets local developers hit
 *     `curl http://localhost:3000/api/cron/cost-rollup`
 *     without faking a Bearer token.
 */
function authorizeCron(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!env.cronSecret) {
    if (env.nodeEnv === "production") {
      // Fail closed. This is a misconfiguration, not a legitimate
      // state, so we return 500 rather than 401 to surface it as
      // an incident rather than a caller error.
      log.error(
        "CRON_SECRET is unset in production — refusing to run the cron handler. Set the env var and redeploy.",
      );
      sendJson(res, 500, {
        error: "Server misconfigured",
        details: "CRON_SECRET is required in production",
      });
      return false;
    }
    log.warn(
      { nodeEnv: env.nodeEnv },
      "CRON_SECRET is unset — cron handler is unauthenticated (non-prod escape hatch).",
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
  stampRequestId(req, res);
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
