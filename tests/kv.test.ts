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
import { _MemoryKvForTests as MemoryKv } from "../src/services/kv.js";

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
});
