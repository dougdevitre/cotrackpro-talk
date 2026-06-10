/**
 * tests/webConsent.test.ts — Public web SMS opt-in: validation, E.164
 * coercion, IP hashing, durable record shape, and rate limiting.
 */

import "./helpers/setupEnv.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordWebConsent,
  toE164,
  hashIp,
  WEB_SMS_CONSENT_TEXT,
} from "../src/core/webConsent.js";
import {
  _resetKvForTests,
  _setKvForTests,
  type KvStore,
  type PipelineOp,
} from "../src/services/kv.js";

// A capturing in-memory KV so we can assert exactly what gets stored and
// still drive the rate limiter's pipeline path.
function makeCapturingKv(): { store: KvStore; sets: Array<{ key: string; value: string }> } {
  const sets: Array<{ key: string; value: string }> = [];
  const values = new Map<string, string>();
  const counters = new Map<string, number>();
  const store: KvStore = {
    async get(k) {
      return values.get(k) ?? null;
    },
    async set(k, v) {
      sets.push({ key: k, value: v });
      values.set(k, v);
    },
    async incrBy(k, by = 1) {
      const n = (counters.get(k) ?? 0) + by;
      counters.set(k, n);
      return n;
    },
    async delete(k) {
      values.delete(k);
    },
    async pipeline(ops: PipelineOp[]) {
      const out: number[] = [];
      for (const op of ops) {
        if (op.op === "incrBy") {
          const n = (counters.get(op.key) ?? 0) + op.by;
          counters.set(op.key, n);
          out.push(n);
        }
      }
      return out;
    },
  };
  return { store, sets };
}

let cap: ReturnType<typeof makeCapturingKv>;
beforeEach(() => {
  cap = makeCapturingKv();
  _setKvForTests(cap.store);
});
afterEach(() => _resetKvForTests());

describe("toE164", () => {
  it("formats a 10-digit US number", () => {
    assert.equal(toE164("5551234567"), "+15551234567");
  });
  it("formats a pretty-printed US number", () => {
    assert.equal(toE164("(555) 123-4567"), "+15551234567");
  });
  it("formats an 11-digit number with leading 1", () => {
    assert.equal(toE164("1 555 123 4567"), "+15551234567");
  });
  it("passes through an already-valid E.164 number", () => {
    assert.equal(toE164("+447911123456"), "+447911123456");
  });
  it("returns null for junk / too-short input", () => {
    assert.equal(toE164("12345"), null);
    assert.equal(toE164(""), null);
    assert.equal(toE164(undefined), null);
    assert.equal(toE164("not a phone"), null);
  });
});

describe("hashIp", () => {
  it("is deterministic and 32 hex chars", () => {
    const a = hashIp("203.0.113.7");
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.equal(a, hashIp("203.0.113.7"));
  });
  it("differs by IP and never echoes the raw IP", () => {
    const a = hashIp("203.0.113.7");
    assert.notEqual(a, hashIp("203.0.113.8"));
    assert.ok(!a.includes("203.0.113.7"));
  });
});

describe("recordWebConsent", () => {
  const ok = {
    phone: "(555) 123-4567",
    consent: true as const,
    consentText: WEB_SMS_CONSENT_TEXT,
    source: "web",
  };

  it("records a valid opt-in and returns 200", async () => {
    const res = await recordWebConsent(ok, { ip: "203.0.113.7" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it("stores a durable record with the expected shape", async () => {
    await recordWebConsent(ok, { ip: "203.0.113.7" });
    assert.equal(cap.sets.length, 1);
    const { key, value } = cap.sets[0]!;
    assert.match(key, /^consent:web:\+15551234567:/);
    const rec = JSON.parse(value);
    assert.equal(rec.phone, "+15551234567");
    assert.equal(rec.consentText, WEB_SMS_CONSENT_TEXT);
    assert.equal(rec.source, "web");
    assert.match(rec.ipHash, /^[0-9a-f]{32}$/);
    assert.ok(!Number.isNaN(Date.parse(rec.timestamp)));
  });

  it("rejects an invalid phone with 400", async () => {
    const res = await recordWebConsent({ ...ok, phone: "12345" }, { ip: "203.0.113.7" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_phone");
    assert.equal(cap.sets.length, 0);
  });

  it("rejects a missing/false consent flag with 400", async () => {
    const res = await recordWebConsent({ ...ok, consent: false as unknown as true }, { ip: "203.0.113.7" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "consent_required");
    assert.equal(cap.sets.length, 0);
  });

  it("rejects empty consent text with 400", async () => {
    const res = await recordWebConsent({ ...ok, consentText: "" }, { ip: "203.0.113.7" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_consent_text");
  });

  it("rate-limits a flood from one client (429 after the per-minute cap)", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 7; i++) {
      const res = await recordWebConsent(ok, { ip: "198.51.100.1" });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  });

  it("never sends an SMS (no twilio dependency touched) — pure record path", async () => {
    const res = await recordWebConsent(ok, { ip: "203.0.113.9" });
    assert.equal(res.status, 200);
    // The only persistence is the consent record; nothing queued for send.
    assert.equal(cap.sets.length, 1);
  });
});
