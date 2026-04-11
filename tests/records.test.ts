/**
 * tests/records.test.ts — Tests for cursor encoding, limit parsing,
 * auth, and input validation in src/core/records.ts.
 *
 * DYNAMO_ENABLED=false in setupEnv so every dynamo call returns an
 * empty-records stub — that's enough to verify wrapper behavior
 * without a real AWS backend. Full integration tests against DynamoDB
 * are out of scope for unit tests.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeCursor,
  decodeCursor,
  parseLimit,
  MAX_RECORDS_LIMIT,
  authorizeRecords,
  getRecord,
  listRecords,
  listRecordsByRole,
  listRecordsByStatus,
  deleteRecord,
} from "../src/core/records.js";

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a DynamoDB lastKey", () => {
    const lastKey = { callSid: "CA123", startedAt: "2026-04-11T00:00:00Z" };
    const cursor = encodeCursor(lastKey);
    assert.ok(cursor, "should produce a cursor");
    assert.deepEqual(decodeCursor(cursor!), lastKey);
  });

  it("returns null for an undefined lastKey", () => {
    assert.equal(encodeCursor(undefined), null);
  });

  it("uses base64url (no '+', '/', or '=' padding)", () => {
    // Values that would produce URL-unsafe chars in regular base64.
    const c = encodeCursor({
      blob: ">>>>>>>????",
    });
    assert.ok(c);
    assert.ok(!c!.includes("+"));
    assert.ok(!c!.includes("/"));
    assert.ok(!c!.includes("="));
  });

  it("decodeCursor returns undefined for missing input", () => {
    assert.equal(decodeCursor(undefined), undefined);
    assert.equal(decodeCursor(""), undefined);
  });

  it("decodeCursor returns undefined on malformed cursor instead of throwing", () => {
    // If the cursor is user-supplied and corrupted, we don't want to
    // 500 — we want to treat it as "no cursor" and start fresh.
    assert.equal(decodeCursor("not a valid cursor at all !!!"), undefined);
    assert.equal(decodeCursor("ZHVtbXk"), undefined); // "dummy" — valid b64, invalid JSON
  });
});

describe("parseLimit", () => {
  it("returns the fallback for undefined input", () => {
    assert.equal(parseLimit(undefined, 25), 25);
  });

  it("returns the fallback for non-numeric input", () => {
    assert.equal(parseLimit("abc", 25), 25);
  });

  it("returns the fallback for zero or negative input", () => {
    assert.equal(parseLimit("0", 25), 25);
    assert.equal(parseLimit("-10", 25), 25);
  });

  it("returns the parsed value for positive integers", () => {
    assert.equal(parseLimit("50", 25), 50);
  });

  it("tolerates trailing non-digit characters (parseInt behavior)", () => {
    // This is parseInt behavior; document it via test rather than
    // over-engineer. A request with '?limit=50abc' gets limit=50.
    assert.equal(parseLimit("50abc", 25), 50);
  });

  it("caps positive integers at MAX_RECORDS_LIMIT (H-1)", () => {
    // Previously '?limit=10000000' would trigger a massive
    // DynamoDB scan. parseLimit now clamps at 100.
    assert.equal(parseLimit("10000", 25), MAX_RECORDS_LIMIT);
    assert.equal(parseLimit("101", 25), MAX_RECORDS_LIMIT);
    assert.equal(parseLimit("100", 25), 100);
    assert.equal(parseLimit("99", 25), 99);
  });

  it("also caps the fallback if it's somehow > MAX_RECORDS_LIMIT", () => {
    // Defensive: a caller passing fallback=9999 should still be
    // clamped. Prevents future regressions.
    assert.equal(parseLimit(undefined, 9999), MAX_RECORDS_LIMIT);
    assert.equal(parseLimit("abc", 9999), MAX_RECORDS_LIMIT);
  });
});

describe("authorizeRecords", () => {
  // setupEnv does NOT set OUTBOUND_API_KEY so auth is disabled in
  // this test file. Check disabled semantics first.
  it("returns null (= allow) when OUTBOUND_API_KEY is unset", () => {
    assert.equal(authorizeRecords(undefined), null);
    assert.equal(authorizeRecords("Bearer whatever"), null);
  });

  // Enabled-auth path is exercised indirectly by the outbound.test.ts
  // tests against the same authorize helper family. Re-importing env
  // mid-run to flip the key isn't practical because env.ts caches
  // values at import time.
});

describe("getRecord", () => {
  it("returns 400 on missing callSid", async () => {
    const r = await getRecord(undefined);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.body.error, /Missing callSid/);
    }
  });

  it("returns 404 when DynamoDB is disabled (stub returns null)", async () => {
    const r = await getRecord("CA123");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 404);
  });
});

describe("listRecords", () => {
  it("returns empty records + null cursor when DynamoDB is disabled", async () => {
    const r = await listRecords({});
    assert.equal(r.ok, true);
    if (r.ok && r.body) {
      assert.deepEqual(r.body.records, []);
      assert.equal(r.body.cursor, null);
    }
  });

  it("silently ignores an undecodable cursor", async () => {
    const r = await listRecords({ cursor: "garbage" });
    assert.equal(r.ok, true);
  });
});

describe("listRecordsByRole", () => {
  it("returns 400 on missing role", async () => {
    const r = await listRecordsByRole(undefined, {});
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it("returns 400 on an unknown role (H-2)", async () => {
    // Previously this was silently cast via `as CoTrackProRole` and
    // returned an empty list. Now it explicitly 400s.
    const r = await listRecordsByRole("administrator", {});
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.body.error, /Unknown role/);
    }
  });

  it("accepts date-range query params for a valid role", async () => {
    const r = await listRecordsByRole("parent", {
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-04-11T00:00:00Z",
      limit: "50",
    });
    assert.equal(r.ok, true);
  });
});

describe("listRecordsByStatus", () => {
  it("returns 400 on missing status", async () => {
    const r = await listRecordsByStatus(undefined, {});
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it("returns 400 on an unknown status (H-2)", async () => {
    const r = await listRecordsByStatus("pending", {});
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.body.error, /Unknown status/);
    }
  });

  it("accepts a valid status", async () => {
    const r = await listRecordsByStatus("completed", {});
    assert.equal(r.ok, true);
  });
});

describe("deleteRecord", () => {
  it("returns 400 on missing callSid", async () => {
    const r = await deleteRecord(undefined);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it("returns 404 when the record doesn't exist (dynamo disabled)", async () => {
    const r = await deleteRecord("CA-does-not-exist");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 404);
  });
});
