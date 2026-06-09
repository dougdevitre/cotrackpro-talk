/**
 * tests/dynamoKv.test.ts — DynamoKv backend logic.
 *
 * Drives DynamoKv through a Map-backed fake DynamoKvClient that mirrors
 * the DynamoDB semantics the real adapter relies on (atomic ADD, and
 * `if_not_exists(expireAt, …)` so the TTL is set only on the first
 * counter write). No AWS is touched. TTL-on-read filtering is exercised
 * with the Date mock, matching the MemoryKv suite.
 */

import "./helpers/setupEnv.js";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  _DynamoKvForTests as DynamoKv,
  type DynamoKvClient,
  type DynamoKvItem,
} from "../src/services/kv.js";

/** In-memory stand-in for the AWS SDK DocumentClient adapter. Replicates
 *  the exact semantics DynamoKv depends on. */
class FakeDynamoClient implements DynamoKvClient {
  store = new Map<string, DynamoKvItem>();

  async getItem(pk: string): Promise<DynamoKvItem | null> {
    const it = this.store.get(pk);
    return it ? { ...it } : null;
  }

  async putItem(item: DynamoKvItem): Promise<void> {
    // Emulate marshallOptions.removeUndefinedValues: undefined attrs are
    // simply not stored (so a no-TTL set carries no expireAt).
    const copy: DynamoKvItem = { pk: item.pk };
    if (item.v !== undefined) copy.v = item.v;
    if (item.n !== undefined) copy.n = item.n;
    if (item.expireAt !== undefined) copy.expireAt = item.expireAt;
    this.store.set(item.pk, copy);
  }

  async addToCounter(pk: string, by: number, expireAt?: number): Promise<number> {
    const it = this.store.get(pk);
    const n = (it?.n ?? 0) + by;
    const next: DynamoKvItem = { pk, n };
    // if_not_exists(expireAt, :e): keep an existing TTL, else take the new one.
    const exp = it?.expireAt ?? expireAt;
    if (exp !== undefined) next.expireAt = exp;
    this.store.set(pk, next);
    return n;
  }

  async deleteItem(pk: string): Promise<void> {
    this.store.delete(pk);
  }
}

describe("DynamoKv", () => {
  let client: FakeDynamoClient;
  let store: DynamoKv;

  beforeEach(() => {
    client = new FakeDynamoClient();
    store = new DynamoKv(client);
  });
  afterEach(() => mock.timers.reset());

  describe("get / set", () => {
    it("returns null for a missing key", async () => {
      assert.equal(await store.get("nope"), null);
    });

    it("round-trips a string value", async () => {
      await store.set("k", "hello");
      assert.equal(await store.get("k"), "hello");
    });

    it("a no-TTL set stores no expireAt (never expires on read)", async () => {
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000);
      await store.set("k", "v");
      mock.timers.setTime(9_999_000_000); // far future
      assert.equal(await store.get("k"), "v");
    });
  });

  describe("TTL (lazy-delete safe, filtered on read)", () => {
    it("returns the value before expiry and null after", async () => {
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000); // now = 1000s
      await store.set("k", "v", 10); // expireAt = 1010s

      mock.timers.setTime(1_009_000); // 1009s — still valid
      assert.equal(await store.get("k"), "v");

      mock.timers.setTime(1_011_000); // 1011s — past expiry
      assert.equal(await store.get("k"), null);
    });
  });

  describe("delete", () => {
    it("removes a key", async () => {
      await store.set("k", "v");
      await store.delete("k");
      assert.equal(await store.get("k"), null);
    });
  });

  describe("incrBy", () => {
    it("creates and increments a counter", async () => {
      assert.equal(await store.incrBy("c"), 1);
      assert.equal(await store.incrBy("c", 4), 5);
      assert.equal(await store.get("c"), "5"); // get on a counter returns String(n)
    });

    it("sets the TTL only on the first write (if_not_exists)", async () => {
      mock.timers.enable({ apis: ["Date"] });
      mock.timers.setTime(1_000_000); // 1000s
      await store.incrBy("c", 1, 10); // expireAt fixed at 1010s

      mock.timers.setTime(1_005_000); // 1005s
      await store.incrBy("c", 1, 10); // must NOT push expiry to 1015s

      mock.timers.setTime(1_011_000); // 1011s — past the ORIGINAL 1010s
      assert.equal(await store.get("c"), null, "TTL stayed at the first-write value");
    });
  });

  describe("pipeline", () => {
    it("runs incrBy ops in order and returns their new values", async () => {
      const out = await store.pipeline([
        { op: "incrBy", key: "a", by: 1, ttlSeconds: 60 },
        { op: "incrBy", key: "b", by: 2, ttlSeconds: 60 },
      ]);
      assert.deepEqual(out, [1, 2]);
      assert.equal(await store.get("a"), "1");
      assert.equal(await store.get("b"), "2");
    });
  });
});
