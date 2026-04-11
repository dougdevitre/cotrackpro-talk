/**
 * tests/costRollup.test.ts — Tests for the cost-rollup aggregation
 * logic. Only the pure aggregation function is unit-tested; the full
 * computeCostRollup path that pages through DynamoDB is exercised in
 * integration tests (with a live table).
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateRecords,
  emptyTotals,
  last24Hours,
  computeCostRollup,
} from "../src/core/costRollup.js";
import type { CallRecord, CoTrackProRole } from "../src/types/index.js";

function makeRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callSid: "CAtest000",
    role: "parent",
    direction: "inbound",
    callerNumber: "+15551234567",
    startedAt: "2026-04-10T12:00:00Z",
    status: "completed",
    turnCount: 0,
    transcript: [],
    safetyEvents: [],
    toolCalls: [],
    ...overrides,
  };
}

describe("emptyTotals", () => {
  it("initializes all counters to zero", () => {
    const t = emptyTotals();
    assert.equal(t.callCount, 0);
    assert.equal(t.totalDurationSecs, 0);
    assert.equal(t.totalTurns, 0);
    assert.equal(t.claudeInputTokens, 0);
    assert.equal(t.claudeOutputTokens, 0);
    assert.equal(t.estimatedCostUsd, 0);
    assert.deepEqual(t.byRole, {});
  });
});

describe("aggregateRecords", () => {
  it("returns zeroed totals for an empty record list", () => {
    const t = aggregateRecords([]);
    assert.equal(t.callCount, 0);
    assert.equal(t.estimatedCostUsd, 0);
  });

  it("sums a single record's cost summary", () => {
    const t = aggregateRecords([
      makeRecord({
        durationSecs: 120,
        turnCount: 8,
        costSummary: {
          claudeInputTokens: 500,
          claudeOutputTokens: 300,
          claudeCacheCreationTokens: 800,
          claudeCacheReadTokens: 5000,
          ttsChars: 1200,
          ttsCharsCached: 100,
          sttSecs: 95.2,
          estimatedCostUsd: 0.0142,
        },
      }),
    ]);

    assert.equal(t.callCount, 1);
    assert.equal(t.totalDurationSecs, 120);
    assert.equal(t.totalTurns, 8);
    assert.equal(t.claudeInputTokens, 500);
    assert.equal(t.claudeOutputTokens, 300);
    assert.equal(t.claudeCacheCreationTokens, 800);
    assert.equal(t.claudeCacheReadTokens, 5000);
    assert.equal(t.ttsChars, 1200);
    assert.equal(t.ttsCharsCached, 100);
    assert.equal(t.sttSecs, 95.2);
    assert.equal(t.estimatedCostUsd, 0.0142);
  });

  it("sums across multiple records", () => {
    const t = aggregateRecords([
      makeRecord({
        durationSecs: 100,
        turnCount: 5,
        costSummary: {
          claudeInputTokens: 100,
          claudeOutputTokens: 50,
          claudeCacheCreationTokens: 0,
          claudeCacheReadTokens: 0,
          ttsChars: 200,
          ttsCharsCached: 0,
          sttSecs: 80,
          estimatedCostUsd: 0.01,
        },
      }),
      makeRecord({
        callSid: "CAtest001",
        durationSecs: 200,
        turnCount: 10,
        costSummary: {
          claudeInputTokens: 250,
          claudeOutputTokens: 150,
          claudeCacheCreationTokens: 0,
          claudeCacheReadTokens: 2000,
          ttsChars: 500,
          ttsCharsCached: 50,
          sttSecs: 180,
          estimatedCostUsd: 0.025,
        },
      }),
    ]);

    assert.equal(t.callCount, 2);
    assert.equal(t.totalDurationSecs, 300);
    assert.equal(t.totalTurns, 15);
    assert.equal(t.claudeInputTokens, 350);
    assert.equal(t.claudeOutputTokens, 200);
    assert.equal(t.claudeCacheReadTokens, 2000);
    assert.equal(t.ttsChars, 700);
    assert.equal(t.ttsCharsCached, 50);
    assert.equal(t.sttSecs, 260);
    // Floating-point: use a tolerance.
    assert.ok(Math.abs(t.estimatedCostUsd - 0.035) < 1e-9);
  });

  it("tolerates records with no costSummary", () => {
    // e.g. active calls or failed records that never got finalized.
    const t = aggregateRecords([
      makeRecord({
        status: "failed",
        durationSecs: 10,
        turnCount: 1,
      }),
    ]);
    assert.equal(t.callCount, 1);
    assert.equal(t.totalDurationSecs, 10);
    assert.equal(t.totalTurns, 1);
    assert.equal(t.estimatedCostUsd, 0);
    assert.equal(t.claudeInputTokens, 0);
  });

  it("breaks cost down by role", () => {
    const roles: CoTrackProRole[] = ["parent", "attorney", "parent"];
    const t = aggregateRecords(
      roles.map((role, i) =>
        makeRecord({
          callSid: `CA${i}`,
          role,
          costSummary: {
            claudeInputTokens: 0,
            claudeOutputTokens: 0,
            claudeCacheCreationTokens: 0,
            claudeCacheReadTokens: 0,
            ttsChars: 0,
            ttsCharsCached: 0,
            sttSecs: 0,
            estimatedCostUsd: 0.1 * (i + 1), // 0.1, 0.2, 0.3
          },
        }),
      ),
    );

    assert.equal(t.byRole.parent?.callCount, 2);
    assert.equal(t.byRole.attorney?.callCount, 1);
    // parent: 0.1 + 0.3 = 0.4
    assert.ok(Math.abs((t.byRole.parent?.estimatedCostUsd ?? 0) - 0.4) < 1e-9);
    assert.ok(Math.abs((t.byRole.attorney?.estimatedCostUsd ?? 0) - 0.2) < 1e-9);
  });

  it("groups under 'unknown' when role is missing", () => {
    // Defensive: shouldn't happen in practice but aggregation should
    // not throw if a record is malformed.
    const t = aggregateRecords([
      makeRecord({ role: undefined as unknown as CoTrackProRole }),
    ]);
    assert.equal(t.byRole.unknown?.callCount, 1);
  });
});

describe("last24Hours", () => {
  it("returns two ISO 8601 timestamps 24 hours apart", () => {
    const { start, end } = last24Hours();
    // Parseable
    const s = new Date(start);
    const e = new Date(end);
    assert.ok(!isNaN(s.getTime()));
    assert.ok(!isNaN(e.getTime()));

    // ~24h apart (allow 1s drift for test execution time)
    const diff = e.getTime() - s.getTime();
    assert.ok(
      Math.abs(diff - 24 * 60 * 60 * 1000) < 1000,
      `expected ~24h, got ${diff}ms`,
    );
  });

  it("end is approximately now", () => {
    const { end } = last24Hours();
    const diff = Math.abs(new Date(end).getTime() - Date.now());
    assert.ok(diff < 1000, "end should be within 1s of Date.now()");
  });
});

describe("computeCostRollup (dynamo disabled)", () => {
  it("returns an empty rollup when DynamoDB is disabled", async () => {
    // With DYNAMO_ENABLED=false, listCallsByStatus returns { records: [] }
    // and the loop exits immediately.
    const result = await computeCostRollup(
      "2026-04-10T00:00:00Z",
      "2026-04-11T00:00:00Z",
    );
    assert.equal(result.totals.callCount, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.pagesRead, 1, "should read exactly one empty page");
    assert.equal(result.windowStart, "2026-04-10T00:00:00Z");
    assert.equal(result.windowEnd, "2026-04-11T00:00:00Z");
  });
});
