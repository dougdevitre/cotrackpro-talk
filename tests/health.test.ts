/**
 * tests/health.test.ts — /health, shallow and deep.
 *
 * The point of the deep mode is that it can FAIL. Every KV consumer in
 * this codebase fails open, so a broken backend produces no failed
 * requests and no alert — which is exactly why a check that returns 200
 * regardless would be worse than useless here. These tests are mostly
 * about the 503s.
 *
 * setupEnvHub is used (not setupEnv) because it sets OUTBOUND_API_KEY.
 * Without a configured bearer, authorizeHubBearer takes its non-prod
 * escape hatch and returns null for everyone, so the auth assertions
 * would pass vacuously.
 */

import "./helpers/setupEnvHub.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mockRequest, mockResponse } from "./helpers/mockHttp.js";
import handler from "../api/health.js";
import { wantsDeep } from "../src/core/health.js";
import {
  _resetKvForTests,
  _setKvForTests,
  _MemoryKvForTests,
} from "../src/services/kv.js";
import type { KvStore, KvBackendInfo } from "../src/services/kv.js";

const BEARER = { authorization: "Bearer test-shared-bearer" };

/** What a healthy Upstash deploy's info record looks like. */
const DURABLE: KvBackendInfo = {
  backend: "upstash",
  reason: "auto-detected",
  durable: true,
  detail: "https://fake.upstash.io",
};

/** A store whose every operation fails, like a bad token would. */
function brokenKv(message: string): KvStore {
  const boom = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    get: boom,
    set: boom,
    incrBy: boom,
    delete: boom,
    pipeline: boom,
  };
}

type KvBlock = {
  backend: string;
  reason: string;
  durable: boolean;
  detail?: string;
  probe?: { ok: boolean; roundTripMs?: number; error?: string };
};

async function callHealth(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number | undefined; body: { kv?: KvBlock } & Record<string, unknown> }> {
  const req = mockRequest({ url, method: "GET", headers });
  const { res, getStatus, getBody } = mockResponse();
  await handler(req, res);
  return { status: getStatus(), body: JSON.parse(getBody() || "{}") };
}

describe("wantsDeep", () => {
  it("is false with no query string", () => {
    assert.equal(wantsDeep("/health"), false);
    assert.equal(wantsDeep(undefined), false);
  });

  it("is true for ?deep=1 and bare ?deep", () => {
    assert.equal(wantsDeep("/health?deep=1"), true);
    assert.equal(wantsDeep("/health?deep"), true);
    assert.equal(wantsDeep("/health?deep=true"), true);
  });

  // A script doing `curl "$HOST/health?deep=$DEEP"` with DEEP unset or 0
  // should get the shallow check, not an unauthorized deep one.
  it("is false for the falsey spellings", () => {
    assert.equal(wantsDeep("/health?deep=0"), false);
    assert.equal(wantsDeep("/health?deep=false"), false);
    assert.equal(wantsDeep("/health?deep=no"), false);
  });

  it("ignores unrelated params", () => {
    assert.equal(wantsDeep("/health?verbose=1"), false);
    assert.equal(wantsDeep("/health?verbose=1&deep=1"), true);
  });
});

describe("GET /health (shallow)", () => {
  beforeEach(() => _resetKvForTests());
  afterEach(() => _resetKvForTests());

  it("returns 200 with the liveness fields", async () => {
    const { status, body } = await callHealth("/health");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.tier, "api");
    assert.equal(typeof body.uptime, "number");
  });

  it("reports the backend without requiring a bearer", async () => {
    const { body } = await callHealth("/health");
    assert.equal(body.kv?.backend, "memory");
    assert.equal(body.kv?.durable, false);
    assert.equal(body.kv?.reason, "configured"); // KV_BACKEND=memory in setupEnv
  });

  // `detail` carries the backend host, and the probe writes. Neither
  // belongs on an unauthenticated endpoint.
  it("omits detail and the probe", async () => {
    const { body } = await callHealth("/health");
    assert.equal(body.kv?.detail, undefined);
    assert.equal(body.kv?.probe, undefined);
  });

  // A config problem shouldn't page someone as though the host were down.
  it("stays 200 even though the backend is not durable", async () => {
    const { status } = await callHealth("/health");
    assert.equal(status, 200);
  });

  it("rejects non-GET", async () => {
    const req = mockRequest({ url: "/health", method: "POST" });
    const { res, getStatus } = mockResponse();
    await handler(req, res);
    assert.equal(getStatus(), 405);
  });
});

describe("GET /health?deep=1", () => {
  beforeEach(() => _resetKvForTests());
  afterEach(() => _resetKvForTests());

  it("401s without a bearer", async () => {
    const { status, body } = await callHealth("/health?deep=1");
    assert.equal(status, 401);
    assert.equal(body.error, "unauthorized");
    assert.equal(body.kv, undefined, "must not leak the backend to an unauthorized caller");
  });

  it("401s on a wrong bearer", async () => {
    const { status } = await callHealth("/health?deep=1", {
      authorization: "Bearer not-the-key",
    });
    assert.equal(status, 401);
  });

  // The whole reason deep mode exists: an in-memory backend on a
  // multi-instance deploy is a broken deploy, and must be a red exit code.
  it("503s on a non-durable backend, and says it didn't probe", async () => {
    const { status, body } = await callHealth("/health?deep=1", BEARER);
    assert.equal(status, 503);
    assert.equal(body.kv?.durable, false);
    assert.equal(body.kv?.probe?.ok, false);
    assert.match(body.kv?.probe?.error ?? "", /not durable/);
  });

  it("200s with a round-trip time when the backend works", async () => {
    _setKvForTests(new _MemoryKvForTests(), DURABLE);
    const { status, body } = await callHealth("/health?deep=1", BEARER);
    assert.equal(status, 200);
    assert.equal(body.kv?.backend, "upstash");
    assert.equal(body.kv?.durable, true);
    assert.equal(body.kv?.detail, "https://fake.upstash.io");
    assert.equal(body.kv?.probe?.ok, true);
    assert.equal(typeof body.kv?.probe?.roundTripMs, "number");
  });

  // Configured is not working. This is the DynamoDB-with-no-IAM-key case
  // and the Upstash-with-a-revoked-token case: healthy at startup,
  // dead at call time, silent because every caller swallows the throw.
  it("503s when a durable backend is configured but throws", async () => {
    _setKvForTests(brokenKv("WRONGPASS invalid token"), DURABLE);
    const { status, body } = await callHealth("/health?deep=1", BEARER);
    assert.equal(status, 503);
    assert.equal(body.kv?.durable, true, "still reports what was configured");
    assert.equal(body.kv?.probe?.ok, false);
    assert.match(body.kv?.probe?.error ?? "", /WRONGPASS/);
  });

  // A backend that accepts writes but returns something else is corrupt,
  // not healthy — probeKv compares the read-back value.
  it("503s when the read-back doesn't match what was written", async () => {
    const lying: KvStore = {
      ...brokenKv("unused"),
      set: async () => {},
      get: async () => "some other value",
      delete: async () => {},
    };
    _setKvForTests(lying, DURABLE);
    const { status, body } = await callHealth("/health?deep=1", BEARER);
    assert.equal(status, 503);
    assert.match(body.kv?.probe?.error ?? "", /mismatch/);
  });
});
