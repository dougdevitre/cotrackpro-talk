/**
 * tests/kv.test.ts — Tests for the in-memory KV backend.
 *
 * The Upstash REST backend is not covered here because it requires a
 * live network or a fetch mock; it's tested manually against a real
 * Upstash instance during rollout.
 */

import "./helpers/setupEnv.js";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  _MemoryKvForTests as MemoryKv,
  MEMORY_KV_SWEEP_EVERY_N_WRITES,
} from "../src/services/kv.js";

describe("MemoryKv", () => {
  let store: InstanceType<typeof MemoryKv>;

  beforeEach(() => {
    store = new MemoryKv();
  });

  afterEach(() => {
    // Reset any time mocks between tests.
    mock.timers.reset();
  });

  describe("get / set", () => {
    it("returns null for a missing key", async () => {
      assert.equal(await store.get("missing"), null);
    });

    it("returns the value that was set", async () => {
      await store.set("k", "v");
      assert.equal(await store.get("k"), "v");
    });

    it("overwrites existing values", async () => {
      await store.set("k", "one");
      await store.set("k", "two");
      assert.equal(await store.get("k"), "two");
    });

    it("preserves non-string-looking values as strings", async () => {
      await store.set("k", "");
      assert.equal(await store.get("k"), "");
    });
  });

  describe("TTL expiry", () => {
    it("expires a value after its TTL elapses", async () => {
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000);

      await store.set("k", "v", 10); // 10 seconds
      assert.equal(await store.get("k"), "v");

      mock.timers.tick(9_999);
      assert.equal(await store.get("k"), "v", "not yet expired");

      mock.timers.tick(2);
      assert.equal(await store.get("k"), null, "expired");
    });

    it("values with no TTL persist indefinitely", async () => {
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000);

      await store.set("k", "v");
      mock.timers.tick(100 * 365 * 24 * 60 * 60 * 1000); // 100 years
      assert.equal(await store.get("k"), "v");
    });
  });

  describe("incrBy", () => {
    it("creates a new key at `by` when missing", async () => {
      assert.equal(await store.incrBy("counter", 5), 5);
      assert.equal(await store.get("counter"), "5");
    });

    it("defaults `by` to 1", async () => {
      assert.equal(await store.incrBy("counter"), 1);
      assert.equal(await store.incrBy("counter"), 2);
      assert.equal(await store.incrBy("counter"), 3);
    });

    it("increments existing integer values", async () => {
      await store.set("counter", "10");
      assert.equal(await store.incrBy("counter", 3), 13);
    });

    it("sets TTL on creation only, not on subsequent increments", async () => {
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000);

      // First increment: creates the key with a 10-second TTL.
      await store.incrBy("counter", 1, 10);
      assert.equal(await store.get("counter"), "1");

      // Advance 5 seconds, then increment again. TTL should NOT reset.
      mock.timers.tick(5_000);
      await store.incrBy("counter", 1, 10);
      assert.equal(await store.get("counter"), "2");

      // 6 seconds later (11s total from start) the key should be gone
      // because the original TTL was preserved.
      mock.timers.tick(6_000);
      assert.equal(
        await store.get("counter"),
        null,
        "TTL should have been preserved from the first incrBy",
      );
    });

    it("treats an expired key as a fresh create", async () => {
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000);

      await store.incrBy("counter", 1, 5);
      mock.timers.tick(6_000); // expired

      // Expired → next incrBy starts fresh at `by`.
      assert.equal(await store.incrBy("counter", 7, 5), 7);
    });
  });

  describe("delete", () => {
    it("removes a key", async () => {
      await store.set("k", "v");
      await store.delete("k");
      assert.equal(await store.get("k"), null);
    });

    it("is a no-op for missing keys", async () => {
      await store.delete("missing"); // must not throw
      assert.equal(await store.get("missing"), null);
    });
  });

  // ── Pipeline (M-1) ───────────────────────────────────────────────────
  //
  // MemoryKv's pipeline is just sequential incrBy calls wrapped in an
  // array result. It's a drop-in replacement for two split incrBys
  // and is already atomic in single-threaded JS. The UpstashKv
  // pipeline (which actually ships commands to the /pipeline
  // endpoint) is not covered here — testing it requires faking
  // fetch(). It's exercised end-to-end during rollout.

  describe("pipeline", () => {
    it("runs a single incrBy and returns its result in an array", async () => {
      const r = await store.pipeline([
        { op: "incrBy", key: "k", by: 1 },
      ]);
      assert.deepEqual(r, [1]);
    });

    it("runs multiple incrBys against different keys", async () => {
      await store.set("alpha", "5"); // pre-existing value
      const r = await store.pipeline([
        { op: "incrBy", key: "alpha", by: 1 },
        { op: "incrBy", key: "beta", by: 3 },
      ]);
      assert.deepEqual(r, [6, 3]);
      assert.equal(await store.get("alpha"), "6");
      assert.equal(await store.get("beta"), "3");
    });

    it("respects ttlSeconds on first increment only (matches incrBy semantics)", async () => {
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000);

      await store.pipeline([
        { op: "incrBy", key: "c", by: 1, ttlSeconds: 5 },
      ]);
      // Before expiry the counter is still there.
      mock.timers.tick(2_000);
      assert.equal(await store.get("c"), "1");
      // After expiry it's gone.
      mock.timers.tick(4_000);
      assert.equal(await store.get("c"), null);
    });

    it("returns results in the same order as the input", async () => {
      const r = await store.pipeline([
        { op: "incrBy", key: "a", by: 10 },
        { op: "incrBy", key: "b", by: 20 },
        { op: "incrBy", key: "c", by: 30 },
      ]);
      assert.deepEqual(r, [10, 20, 30]);
    });

    it("is a no-op for an empty op list", async () => {
      const r = await store.pipeline([]);
      assert.deepEqual(r, []);
    });
  });

  // ── Expiry sweep (M-5) ───────────────────────────────────────────────
  //
  // Covers the amortized sweep added to stop a write-heavy,
  // read-light caller (e.g. the idempotency cache on a busy API)
  // from growing the Map unboundedly. The sweep runs every
  // MEMORY_KV_SWEEP_EVERY_N_WRITES writes AND is also force-callable
  // for direct testing.

  describe("expiry sweep", () => {
    it("drops expired entries on sweep", async () => {
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000);

      await store.set("alive", "1", 60);
      await store.set("dying", "2", 1);

      mock.timers.tick(2_000); // "dying" now expired

      // Both still physically present (lazy cleanup hasn't kicked in
      // yet — we haven't read them, and we're nowhere near the sweep
      // threshold).
      assert.equal(store._sizeForTests(), 2);

      store._sweepNowForTests();

      // Dying is gone, alive remains.
      assert.equal(store._sizeForTests(), 1);
      assert.equal(await store.get("alive"), "1");
      assert.equal(await store.get("dying"), null);
    });

    it("leaves keys with no TTL alone", async () => {
      await store.set("forever", "yes"); // no TTL
      store._sweepNowForTests();
      assert.equal(await store.get("forever"), "yes");
    });

    it("auto-sweeps every N writes", async () => {
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000);

      // Plant some TTL-having entries that will expire.
      for (let i = 0; i < 10; i++) {
        await store.set("expiring:" + i, "v", 1);
      }
      // Add one permanent entry.
      await store.set("keep", "v");

      mock.timers.tick(2_000); // expire the TTL entries

      // None of the writes above crossed the sweep threshold, so
      // everything is still physically present.
      assert.equal(store._sizeForTests(), 11);

      // Now pound on the store until we cross the threshold. Each
      // write bumps the internal writeCount; the sweep runs when
      // writeCount % N === 0.
      const existingWrites = store._writeCountForTests();
      const needed =
        MEMORY_KV_SWEEP_EVERY_N_WRITES -
        (existingWrites % MEMORY_KV_SWEEP_EVERY_N_WRITES);
      for (let i = 0; i < needed; i++) {
        // Distinct keys so each set() actually adds a Map entry.
        // Use a far-future TTL so they stay alive.
        await store.set("pad:" + i, "v", 3600);
      }

      // After the crossing-write triggered sweep, the 10 expiring
      // entries should be gone. `keep` + the `pad:*` entries remain.
      assert.equal(
        store._sizeForTests(),
        1 + needed,
        "expired entries should have been swept",
      );
      assert.equal(await store.get("keep"), "v");
    });

    it("incrBy also triggers the sweep counter", async () => {
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000);

      await store.set("dead:1", "v", 1);
      await store.set("dead:2", "v", 1);
      mock.timers.tick(2_000);

      // Push the write counter across the threshold using incrBy.
      const existingWrites = store._writeCountForTests();
      const needed =
        MEMORY_KV_SWEEP_EVERY_N_WRITES -
        (existingWrites % MEMORY_KV_SWEEP_EVERY_N_WRITES);
      for (let i = 0; i < needed; i++) {
        await store.incrBy("counter:" + i, 1, 3600);
      }

      // The 2 dead entries should have been swept, counter:* entries
      // are still alive.
      assert.equal(await store.get("dead:1"), null);
      assert.equal(await store.get("dead:2"), null);
    });

    it("does not sweep before the threshold is crossed", async () => {
      // One write — write counter at 1. Well below the threshold, so
      // no sweep runs.
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000);
      await store.set("expired", "v", 1);
      mock.timers.tick(2_000);
      // Add a handful of non-expired entries that shouldn't trigger
      // a sweep.
      for (let i = 0; i < 10; i++) {
        await store.set("other:" + i, "v");
      }
      // "expired" is still physically present even though it's
      // expired — we haven't swept and we haven't read it.
      assert.equal(store._sizeForTests(), 11);
    });
  });
});
