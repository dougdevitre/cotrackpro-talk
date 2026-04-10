/**
 * utils/costEstimator.ts — Pure USD cost estimator from call metrics.
 *
 * Computes an estimated dollar cost for a single call given the raw metrics
 * (Claude tokens, TTS chars, STT seconds) and env-configured per-unit prices.
 *
 * Prices are env-overridable (see src/config/env.ts) so they can be updated
 * as provider pricing changes without a code deploy.
 */

import { env } from "../config/env.js";
import type { CallCostMetrics, CallCostSummary } from "../types/index.js";

/**
 * Estimate the USD cost of a single call from its accumulated metrics.
 * Returns a finalized CallCostSummary suitable for persistence/logging.
 */
export function estimateCallCost(metrics: CallCostMetrics): CallCostSummary {
  // Claude — tokens are typically priced per million
  const claudeInputCost =
    (metrics.claudeInputTokens / 1_000_000) * env.claudeInputPricePerMTok;
  const claudeOutputCost =
    (metrics.claudeOutputTokens / 1_000_000) * env.claudeOutputPricePerMTok;
  const claudeCacheWriteCost =
    (metrics.claudeCacheCreationTokens / 1_000_000) *
    env.claudeCacheWritePricePerMTok;
  const claudeCacheReadCost =
    (metrics.claudeCacheReadTokens / 1_000_000) *
    env.claudeCacheReadPricePerMTok;

  // ElevenLabs TTS — per 1K characters (only non-cached chars are billed)
  const ttsCost =
    (metrics.ttsChars / 1_000) * env.elevenLabsTtsPricePer1KChars;

  // ElevenLabs STT — per minute
  const sttCost = (metrics.sttSecs / 60) * env.elevenLabsSttPricePerMin;

  const estimatedCostUsd =
    claudeInputCost +
    claudeOutputCost +
    claudeCacheWriteCost +
    claudeCacheReadCost +
    ttsCost +
    sttCost;

  return {
    claudeInputTokens: metrics.claudeInputTokens,
    claudeOutputTokens: metrics.claudeOutputTokens,
    claudeCacheCreationTokens: metrics.claudeCacheCreationTokens,
    claudeCacheReadTokens: metrics.claudeCacheReadTokens,
    ttsChars: metrics.ttsChars,
    ttsCharsCached: metrics.ttsCharsCached,
    sttSecs: metrics.sttSecs,
    // Round to 6 decimals — micro-dollar precision is enough for aggregation
    estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
  };
}
