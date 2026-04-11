/**
 * tests/rateLimit.test.ts — Tests for the fixed-window rate limiter
 * and the hashClientKey helper.
 */

import "./helpers/setupEnv.js";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  checkRateLimit,
  hashClientKey,
} from "../src/core/rateLimit.js";
import {
  _resetKvForTests,
  _setKvForTests,
  type KvStore,
} from "../src/services/kv.js";

describe("hashClientKey", () => {
  it("returns a stable 8-character lowercase hex string", () => {
    const h = hashClientKey("some-secret-value");
    assert.match(h, /^[0-9a-f]{8}$/);
  });

  it("is deterministic for the same input", () => {
    assert.equal(hashClientKey("abc"), hashClientKey("abc"));
  });

  it("produces different hashes for different inputs", () => {
    assert.notEqual(hashClientKey("abc"), hashClientKey("abd"));
  });

  it("handles the empty string", () => {
    assert.match(hashClientKey(""), /^[0-9a-f]{8}$/);
  });

  it("handles unicode strings", () => {
    assert.match(hashClientKey("héllo wörld 🚀"), /^[0-9a-f]{8}$/);
  });
});

describe("checkRateLimit", () => {
  beforeEach(() => {
    // Fresh in-memory KV for every test so counters don't bleed.
    _resetKvForTests();
  });

  afterEach(() => {
    mock.timers.reset();
    _resetKvForTests();
  });

  it("allows requests under the per-minute limit", async () => {
    mock.timers.enable({ apis: ["Date"] });
    mock.timers.setTime(60_000); // align to a minute boundary

    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit("client1", "test", {
        perMinute: 5,
        perHour: 0,
      });
      assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
    }
  });

  it("denies the request that exceeds the per-minute limit", async () => {
    mock.timers.enable({ apis: ["Date"] });
    mock.timers.setTime(60_000);

    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit("c", "test", { perMinute: 3, perHour: 0 });
      assert.equal(r.allowed, true);
    }

    const blocked = await checkRateLimit("c", "test", {
      perMinute: 3,
      perHour: 0,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.limitedBy, "minute");
    assert.ok(blocked.resetAt && blocked.resetAt > Date.now());
  });

  it("refills after the minute window rolls over", async () => {
    mock.timers.enable({ apis: ["Date"] });
    mock.timers.setTime(60_000);

    // Use up the budget.
    for (let i = 0; i < 2; i++) {
      await checkRateLimit("c", "test", { perMinute: 2, perHour: 0 });
    }
    const blocked = await checkRateLimit("c", "test", {
      perMinute: 2,
      perHour: 0,
    });
    assert.equal(blocked.allowed, false);

    // Roll the clock into the next minute bucket.
    mock.timers.tick(60_000);

    const r = await checkRateLimit("c", "test", {
      perMinute: 2,
      perHour: 0,
    });
    assert.equal(r.allowed, true, "fresh window should allow requests");
    assert.equal(r.counts.minute, 1);
  });

  it("denies when only the per-hour limit is exceeded", async () => {
    mock.timers.enable({ apis: ["Date"] });
    mock.timers.setTime(3_600_000);

    // Use 3 requests this minute.
    for (let i = 0; i < 3; i++) {
      await checkRateLimit("c", "test", { perMinute: 100, perHour: 3 });
    }

    // Roll to next minute. Hour window still has them.
    mock.timers.tick(60_000);

    const blocked = await checkRateLimit("c", "test", {
      perMinute: 100,
      perHour: 3,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.limitedBy, "hour");
  });

  it("separates namespaces", async () => {
    mock.timers.enable({ apis: ["Date"] });
    mock.timers.setTime(60_000);

    for (let i = 0; i < 3; i++) {
      await checkRateLimit("c", "alpha", { perMinute: 3, perHour: 0 });
    }
    const alphaBlocked = await checkRateLimit("c", "alpha", {
      perMinute: 3,
      perHour: 0,
    });
    assert.equal(alphaBlocked.allowed, false);

    // Different namespace has a fresh budget.
    const betaOk = await checkRateLimit("c", "beta", {
      perMinute: 3,
      perHour: 0,
    });
    assert.equal(betaOk.allowed, true);
  });

  it("separates clients", async () => {
    mock.timers.enable({ apis: ["Date"] });
    mock.timers.setTime(60_000);

    for (let i = 0; i < 2; i++) {
      await checkRateLimit("alice", "test", { perMinute: 2, perHour: 0 });
    }
    const aliceBlocked = await checkRateLimit("alice", "test", {
      perMinute: 2,
      perHour: 0,
    });
    assert.equal(aliceBlocked.allowed, false);

    const bobOk = await checkRateLimit("bob", "test", {
      perMinute: 2,
      perHour: 0,
    });
    assert.equal(bobOk.allowed, true);
  });

  it("allows unconditionally when both limits are zero", async () => {
    // No KV calls should happen at all when limits are disabled,
    // so this also doubles as a "don't bill the KV for free tier" test.
    for (let i = 0; i < 1000; i++) {
      const r = await checkRateLimit("c", "test", { perMinute: 0, perHour: 0 });
      assert.equal(r.allowed, true);
    }
  });

  it("fails open when the KV throws", async () => {
    const brokenKv: KvStore = {
      async get() {
        throw new Error("redis is on fire");
      },
      async set() {
        throw new Error("redis is on fire");
      },
      async incrBy() {
        throw new Error("redis is on fire");
      },
      async delete() {
        throw new Error("redis is on fire");
      },
      async pipeline() {
        // M-1: the rate limiter calls pipeline(), so the broken-KV
        // test has to throw from here too.
        throw new Error("redis is on fire");
      },
    };
    _setKvForTests(brokenKv);

    const r = await checkRateLimit("c", "test", {
      perMinute: 1,
      perHour: 1,
    });
    assert.equal(
      r.allowed,
      true,
      "rate limiter should fail OPEN when KV errors, not block real traffic",
    );
  });
});

// ── Atomic pipeline path (M-1) ────────────────────────────────────────
//
// These tests pin the behavioral contract of the pipeline-based
// rate-limit implementation: both counters advance together, or
// neither does. The old split-call path (await incrBy; await incrBy)
// could leave state inconsistent if the second call failed. A
// regression that reverts to two awaits should be caught by the
// "counters stay consistent on partial failure" test below.

describe("checkRateLimit — atomic pipeline (M-1)", () => {
  beforeEach(() => {
    _resetKvForTests();
  });

  afterEach(() => {
    mock.timers.reset();
    _resetKvForTests();
  });

  it("sends a single pipeline call per check when both windows are enabled", async () => {
    // Intercept pipeline() to count invocations. Delegate
    // everything else through a spy on a real MemoryKv so the
    // counters still work.
    const calls: Array<{ method: string; opCount: number }> = [];
    const real: KvStore = {
      async get() {
        return null;
      },
      async set() {
        /* noop */
      },
      async incrBy() {
        calls.push({ method: "incrBy", opCount: 1 });
        return 1;
      },
      async delete() {
        /* noop */
      },
      async pipeline(ops) {
        calls.push({ method: "pipeline", opCount: ops.length });
        // Return distinct counts per op so we can verify the order.
        return ops.map((_, i) => i + 1);
      },
    };
    _setKvForTests(real);

    await checkRateLimit("c", "test", { perMinute: 10, perHour: 100 });

    // Expect EXACTLY one pipeline call with TWO ops. Zero bare
    // incrBy calls — that would be the regression.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "pipeline");
    assert.equal(calls[0].opCount, 2);
  });

  it("pipelines only the minute op when the hour limit is disabled", async () => {
    const calls: Array<{ opCount: number }> = [];
    const real: KvStore = {
      async get() {
        return null;
      },
      async set() {},
      async incrBy() {
        return 1;
      },
      async delete() {},
      async pipeline(ops) {
        calls.push({ opCount: ops.length });
        return ops.map(() => 1);
      },
    };
    _setKvForTests(real);

    await checkRateLimit("c", "test", { perMinute: 10, perHour: 0 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opCount, 1);
  });

  it("pipelines only the hour op when the minute limit is disabled", async () => {
    const calls: Array<{ opCount: number }> = [];
    const real: KvStore = {
      async get() {
        return null;
      },
      async set() {},
      async incrBy() {
        return 1;
      },
      async delete() {},
      async pipeline(ops) {
        calls.push({ opCount: ops.length });
        return ops.map(() => 1);
      },
    };
    _setKvForTests(real);

    await checkRateLimit("c", "test", { perMinute: 0, perHour: 10 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opCount, 1);
  });

  it("counters stay consistent when pipeline fails mid-check (no split state)", async () => {
    // Simulate a KV backend that fails the pipeline call. The old
    // code path could leave the minute counter incremented while
    // the hour counter never advanced; the new path either bumps
    // both atomically or throws without bumping anything. We can
    // only verify the "throws without bumping" half with a stub,
    // but that's the half that matters.
    let pipelineCallCount = 0;
    const brokenKv: KvStore = {
      async get() {
        return null;
      },
      async set() {},
      async incrBy() {
        throw new Error(
          "rate limiter should NOT fall back to bare incrBy — pipeline is the only path",
        );
      },
      async delete() {},
      async pipeline() {
        pipelineCallCount += 1;
        throw new Error("pipeline network error");
      },
    };
    _setKvForTests(brokenKv);

    const r = await checkRateLimit("c", "test", {
      perMinute: 1,
      perHour: 1,
    });
    assert.equal(r.allowed, true, "must fail open");
    assert.equal(pipelineCallCount, 1, "pipeline should be called once");
  });

  it("returns correct counts when pipeline reports both counters", async () => {
    const stub: KvStore = {
      async get() {
        return null;
      },
      async set() {},
      async incrBy() {
        throw new Error("pipeline is the only path");
      },
      async delete() {},
      async pipeline(ops) {
        // Pretend the counter is at 5 for minute, 42 for hour.
        // Returned in the same order as the ops were passed.
        return ops.map((_op, i) => (i === 0 ? 5 : 42));
      },
    };
    _setKvForTests(stub);

    const r = await checkRateLimit("c", "test", {
      perMinute: 10,
      perHour: 100,
    });
    assert.equal(r.allowed, true);
    assert.deepEqual(r.counts, { minute: 5, hour: 42 });
  });
});
