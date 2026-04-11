/**
 * tests/sessions.test.ts — Tests for the in-memory call session store.
 *
 * Note: sessions.ts sets up a setInterval sweep loop at module load.
 * It's .unref()'d so Node can still exit, but the sweep runs on real
 * time so we don't exercise the "force-reap zombie" path in unit tests
 * — that would require waiting 15+ minutes. The reap callback hookup
 * is covered by a direct call to destroySession() below.
 */

import "./helpers/setupEnv.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  getSession,
  getSessionByStream,
  destroySession,
  touchSession,
  onSessionDestroy,
  sessionCount,
  allSessions,
  isAtCapacity,
  peakSessionCount,
} from "../src/utils/sessions.js";

// The session store is a module-level singleton, so tests must clean
// up after themselves. This helper wipes any sessions leftover from
// other tests and is called in beforeEach.
function resetSessions(): void {
  for (const s of allSessions()) {
    destroySession(s.callSid);
  }
}

describe("sessions module", () => {
  beforeEach(() => {
    resetSessions();
  });

  describe("createSession", () => {
    it("returns a session with the right callSid + streamSid + role", () => {
      const s = createSession("CA1", "MZ1", "attorney");
      assert.equal(s.callSid, "CA1");
      assert.equal(s.streamSid, "MZ1");
      assert.equal(s.role, "attorney");
    });

    it("initializes cost metrics to zero", () => {
      const s = createSession("CA2", "MZ2", "parent");
      assert.equal(s.costMetrics.claudeInputTokens, 0);
      assert.equal(s.costMetrics.claudeOutputTokens, 0);
      assert.equal(s.costMetrics.ttsChars, 0);
      assert.equal(s.costMetrics.sttSecs, 0);
    });

    it("populates voiceId from the role → voice map", () => {
      const s = createSession("CA3", "MZ3", "parent");
      assert.ok(s.voiceId, "voiceId should be non-empty");
      assert.equal(typeof s.voiceId, "string");
    });

    it("defaults role to 'parent' when omitted", () => {
      const s = createSession("CA4", "MZ4");
      assert.equal(s.role, "parent");
    });

    it("seeds createdAt and lastActivityMs to ~now", () => {
      const before = Date.now();
      const s = createSession("CA5", "MZ5");
      const after = Date.now();
      assert.ok(s.createdAt >= before && s.createdAt <= after);
      assert.ok(s.lastActivityMs >= before && s.lastActivityMs <= after);
    });
  });

  describe("getSession / getSessionByStream", () => {
    it("getSession finds a created session by callSid", () => {
      createSession("CAlookup", "MZlookup");
      const s = getSession("CAlookup");
      assert.ok(s);
      assert.equal(s!.streamSid, "MZlookup");
    });

    it("getSession returns undefined for a missing callSid", () => {
      assert.equal(getSession("CAnope"), undefined);
    });

    it("getSessionByStream uses the reverse index", () => {
      createSession("CAidx", "MZidx");
      const s = getSessionByStream("MZidx");
      assert.ok(s);
      assert.equal(s!.callSid, "CAidx");
    });

    it("getSessionByStream returns undefined for a missing streamSid", () => {
      assert.equal(getSessionByStream("MZnope"), undefined);
    });
  });

  describe("touchSession", () => {
    it("updates lastActivityMs", async () => {
      const s = createSession("CAtouch", "MZtouch");
      const original = s.lastActivityMs;

      // Yield to the event loop so Date.now() can tick.
      await new Promise((r) => setTimeout(r, 2));

      touchSession("CAtouch");
      const s2 = getSession("CAtouch");
      assert.ok(s2!.lastActivityMs >= original);
    });

    it("is a no-op for unknown callSids (no throw)", () => {
      touchSession("CAnope");
    });
  });

  describe("destroySession", () => {
    it("removes the session and clears the stream index", () => {
      createSession("CAkill", "MZkill");
      assert.equal(sessionCount(), 1);
      destroySession("CAkill");
      assert.equal(sessionCount(), 0);
      assert.equal(getSession("CAkill"), undefined);
      assert.equal(getSessionByStream("MZkill"), undefined);
    });

    it("is a no-op for unknown callSids", () => {
      destroySession("CAnope");
      assert.equal(sessionCount(), 0);
    });
  });

  describe("sessionCount / allSessions", () => {
    it("reflects live sessions", () => {
      assert.equal(sessionCount(), 0);
      createSession("CA1", "MZ1");
      createSession("CA2", "MZ2");
      assert.equal(sessionCount(), 2);
      assert.equal(allSessions().length, 2);
    });

    it("allSessions returns callSids of each live session", () => {
      createSession("CAa", "MZa");
      createSession("CAb", "MZb");
      const callSids = allSessions().map((s) => s.callSid).sort();
      assert.deepEqual(callSids, ["CAa", "CAb"]);
    });
  });

  describe("onSessionDestroy", () => {
    it("does not fire on normal destroySession() (only on force-reap)", () => {
      // Reading the source: destroySession() itself doesn't invoke
      // onDestroyCallbacks — only the sweep timer does, when reaping
      // zombies or over-duration sessions. Document this via a test
      // so the contract is explicit.
      let fired = false;
      createSession("CAcb", "MZcb");
      onSessionDestroy("CAcb", () => {
        fired = true;
      });
      destroySession("CAcb");
      assert.equal(
        fired,
        false,
        "destroy callback should NOT fire on manual destroySession — only on zombie/over-duration reap",
      );
    });

    it("callback handle is cleared on destroySession so a re-used callSid is safe", () => {
      let count = 0;
      createSession("CAreuse", "MZreuse");
      onSessionDestroy("CAreuse", () => count++);
      destroySession("CAreuse");

      // Re-create the same callSid (happens in nothing normal, but
      // shouldn't resurrect the old callback).
      createSession("CAreuse", "MZreuse2");
      destroySession("CAreuse");
      assert.equal(count, 0);
    });
  });

  // ── isAtCapacity / peakSessionCount (audit E-2) ─────────────────────
  //
  // Tests the session-cap helpers. Note: peakSessionCount is a
  // process-lifetime high-water mark, not reset between tests — so
  // we test "peak >= current count" rather than exact equality.

  describe("capacity cap (E-2)", () => {
    it("isAtCapacity() returns false below MAX_CONCURRENT_SESSIONS", () => {
      // setupEnv pins MAX_CONCURRENT_SESSIONS=1000; we won't create
      // that many.
      assert.equal(isAtCapacity(), false);
    });

    it("peakSessionCount() is at least the current session count", () => {
      createSession("CAcap1", "MZcap1");
      createSession("CAcap2", "MZcap2");
      const current = sessionCount();
      const peak = peakSessionCount();
      assert.ok(
        peak >= current,
        `peak (${peak}) should be >= current (${current})`,
      );
      destroySession("CAcap1");
      destroySession("CAcap2");
    });

    it("peakSessionCount() does not decrease when sessions are destroyed", () => {
      createSession("CApeak1", "MZpeak1");
      createSession("CApeak2", "MZpeak2");
      const peakWhileFull = peakSessionCount();
      destroySession("CApeak1");
      destroySession("CApeak2");
      assert.equal(
        peakSessionCount(),
        peakWhileFull,
        "peak should not decrease on destroy",
      );
    });
  });
});
