/**
 * tests/kvBackendSelection.test.ts — KV backend resolution + liveness probe.
 *
 * Backend selection had ZERO coverage before this file, which is how two
 * silent-fallback paths survived: `KV_BACKEND=upstash` with a missing
 * token, and a typo'd `KV_BACKEND`. Both produced a non-durable in-memory
 * store while the config looked deliberate — and because every KV
 * consumer fails open, neither produced a single failed request. The
 * result was missing STOP suppression and non-deduped sends with nothing
 * in the logs but an INFO line claiming everything was fine.
 *
 * The assertions here are as much about the WARNING as the backend:
 * silence is the failure mode being guarded against.
 *
 * These drive `planKvBackend` directly rather than going through env
 * vars, because `env.ts` snapshots process.env at import — mutating it
 * later and re-importing wouldn't change what the module sees.
 */

import "./helpers/setupEnv.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  planKvBackend,
  probeKv,
  kv,
  _setKvForTests,
  _resetKvForTests,
  _MemoryKvForTests as MemoryKv,
  type KvConfig,
} from "../src/services/kv.js";

/** A valid baseline; each test overrides only what it's exercising. */
function cfg(over: Partial<KvConfig> = {}): KvConfig {
  return {
    backend: "auto",
    url: "",
    token: "",
    dynamoTable: "cotrackpro-kv",
    dynamoRegion: "us-east-1",
    ...over,
  };
}

// ── Log capture ───────────────────────────────────────────────────────────────
// The logger writes to stdout; swap the sink so we can assert on warnings.
// LOG_LEVEL is "silent" in tests/helpers/setupEnv.ts, so these assertions
// check the RETURNED reason rather than log text where possible — the
// reason is the structural contract, the log line is the human one.

const originalWrite = process.stdout.write.bind(process.stdout);
let captured: string[] = [];

beforeEach(() => {
  captured = [];
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (c) => {
    captured.push(String(c));
    return true;
  };
});

afterEach(() => {
  (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
  _resetKvForTests();
});

describe("planKvBackend — durable selections", () => {
  it("auto + url + token → upstash, auto-detected", () => {
    const info = planKvBackend(
      cfg({ url: "https://example.upstash.io", token: "tok" }),
    );
    assert.equal(info.backend, "upstash");
    assert.equal(info.reason, "auto-detected");
    assert.equal(info.durable, true);
  });

  it("explicit upstash → upstash, configured", () => {
    const info = planKvBackend(
      cfg({ backend: "upstash", url: "https://example.upstash.io", token: "tok" }),
    );
    assert.equal(info.backend, "upstash");
    assert.equal(info.reason, "configured");
    assert.equal(info.durable, true);
  });

  it("explicit dynamo → dynamo, and names the table it will use", () => {
    const info = planKvBackend(
      cfg({ backend: "dynamo", dynamoTable: "cotrackpro-kv-test" }),
    );
    assert.equal(info.backend, "dynamo");
    assert.equal(info.durable, true);
    assert.match(info.detail, /cotrackpro-kv-test/);
  });

  it("redacts credentials embedded in KV_URL", () => {
    const info = planKvBackend(
      cfg({
        backend: "upstash",
        url: "https://user:sup3rsecret@example.upstash.io",
        token: "tok",
      }),
    );
    assert.ok(!info.detail.includes("sup3rsecret"), "detail must be redacted");
    assert.ok(!captured.join("").includes("sup3rsecret"), "log must be redacted");
  });
});

describe("planKvBackend — memory as a choice vs. memory as a failure", () => {
  it("auto with no credentials → memory, reason 'default'", () => {
    const info = planKvBackend(cfg());
    assert.equal(info.backend, "memory");
    assert.equal(info.reason, "default");
    assert.equal(info.durable, false);
  });

  it("explicit memory → memory, reason 'configured'", () => {
    const info = planKvBackend(cfg({ backend: "memory" }));
    assert.equal(info.backend, "memory");
    assert.equal(info.reason, "configured");
    assert.equal(info.durable, false);
  });

  it("upstash with a missing token → memory, flagged as a FALLBACK", () => {
    const info = planKvBackend(
      cfg({ backend: "upstash", url: "https://example.upstash.io", token: "" }),
    );
    assert.equal(info.backend, "memory");
    assert.equal(info.reason, "fallback-missing-credentials");
    assert.equal(info.durable, false);
    assert.match(info.detail, /KV_URL and\/or KV_TOKEN are unset/);
  });

  it("upstash with a missing URL → memory, flagged as a FALLBACK", () => {
    const info = planKvBackend(cfg({ backend: "upstash", url: "", token: "tok" }));
    assert.equal(info.reason, "fallback-missing-credentials");
    assert.equal(info.durable, false);
  });

  it("an unrecognized backend → memory, and the detail names the bad value", () => {
    const info = planKvBackend(
      cfg({ backend: "dynmao", url: "https://example.upstash.io", token: "tok" }),
    );
    assert.equal(info.backend, "memory");
    assert.equal(info.reason, "fallback-unknown-backend");
    assert.equal(info.durable, false);
    // "It fell back" without saying what was wrong sends an operator hunting.
    assert.match(info.detail, /dynmao/);
    assert.match(info.detail, /auto, memory, upstash, dynamo/);
  });

  it("a typo does not silently defeat otherwise-valid Upstash credentials", () => {
    // The subtle half of the bug: the auto-upstash branch requires the
    // literal "auto", so a typo skipped it even with url+token present.
    // Behavior is still memory — but it must now announce itself.
    const info = planKvBackend(
      cfg({ backend: "upstsh", url: "https://example.upstash.io", token: "tok" }),
    );
    assert.equal(info.durable, false);
    assert.equal(info.reason, "fallback-unknown-backend");
  });

  it("dynamo is never auto-selected", () => {
    // Selecting it implicitly would mean reaching for AWS credentials and
    // a provisioned table that memory/upstash deployments don't have.
    assert.equal(planKvBackend(cfg({ backend: "auto" })).backend, "memory");
  });

  it("every reason maps to the right durability", () => {
    const durableReasons = new Set(["configured", "auto-detected"]);
    for (const c of [
      cfg(),
      cfg({ backend: "memory" }),
      cfg({ backend: "upstash", url: "u", token: "t" }),
      cfg({ backend: "upstash" }),
      cfg({ backend: "dynamo" }),
      cfg({ backend: "garbage" }),
    ]) {
      const info = planKvBackend(c);
      if (!durableReasons.has(info.reason)) {
        assert.equal(info.durable, false, `${info.reason} must not claim durable`);
      }
      if (info.backend === "memory") {
        assert.equal(info.durable, false, "memory is never durable");
      }
    }
  });
});

describe("probeKv", () => {
  it("round-trips a canary and leaves nothing behind", async () => {
    _setKvForTests(new MemoryKv());
    const result = await probeKv();
    assert.equal(result.ok, true);
    assert.equal(await kv().get("kv:probe:canary"), null, "canary must be cleaned up");
  });

  it("reports not-ok rather than throwing when the store is unreachable", async () => {
    _setKvForTests({
      get: async () => {
        throw new Error("backend unreachable");
      },
      set: async () => {
        throw new Error("backend unreachable");
      },
      incrBy: async () => 0,
      delete: async () => {},
      pipeline: async () => [],
    });
    const result = await probeKv();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /backend unreachable/);
  });

  it("catches a store that accepts writes but silently drops them", async () => {
    // The shape of a reachable-but-misconfigured backend (wrong table,
    // wrong prefix, expired TTL semantics). A probe that only watched for
    // a thrown error would call this healthy.
    _setKvForTests({
      get: async () => null,
      set: async () => {},
      incrBy: async () => 0,
      delete: async () => {},
      pipeline: async () => [],
    });
    const result = await probeKv();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /read-back mismatch/);
  });
});
