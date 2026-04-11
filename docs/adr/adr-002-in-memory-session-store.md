# ADR-002: In-memory session store on the audio hot path

**Status:** Accepted — shipped from the start; defended against
Redis-ification in PR #5.

## Context

Each Twilio Media Stream WebSocket is a long-lived connection
carrying per-call state: audio buffers, conversation history, voice
ID, cost metrics, last-activity timestamps. The `src/utils/sessions.ts`
module stores this state in a plain in-process `Map`.

The README originally contained a TODO suggesting "use Redis for
session store (swap `sessions.ts`)." On the surface this sounds
right — it's the textbook multi-instance stateless-server advice.

## Decision

**Keep the session store in-memory. Do not move to Redis.**

Document the rationale prominently in `src/utils/sessions.ts` so a
future contributor reading "why isn't this in Redis?" finds the
answer in-situ. Use the KV abstraction (ADR-004) for cross-instance
state that genuinely needs sharing — rate limits, idempotency —
not for session data.

## Consequences

**Why in-memory is correct for a real-time voice pipeline:**

1. **Each Twilio Media Stream stays pinned to one WS instance for
   its entire lifetime.** The handshake completes on one host and
   the same connection carries every audio frame until hangup.
   There is no scenario where "session state needs to migrate to
   another instance" — losing the instance means losing the WS,
   which means losing the call.

2. **`touchSession()` is on the audio hot path.** It runs on every
   inbound media frame (~50/sec). An async Redis GET/SET per frame
   would:
   - Add 1-5ms of latency to the already-tight audio loop.
   - Blow out the Upstash request budget — a 10-minute call at 50
     writes/sec is 30,000 Redis calls for one session.
   - Introduce a failure mode where Redis latency stalls the audio
     pipeline (fail-open on reads means stale state; fail-closed
     means dropped calls).

3. **No cross-instance coordination is needed for session data.**
   Horizontal scaling of the WS tier works fine with per-instance
   sessions: run N WS instances behind a load balancer, each one
   handles whichever calls it receives, and nothing needs to know
   about sessions on other instances.

4. **Instance death during a call drops the call anyway.** Rehydrating
   session state onto another instance doesn't save the in-flight
   call — the WebSocket connection itself is gone, Twilio has
   already hung up. There's nothing to rehydrate to.

**What this does cost us:**

- A WS host crash loses every active call's session state, not just
  the ones that were crashing anyway. Acceptable — voice calls are
  ephemeral by nature.
- Operators can't inspect live sessions from an external tool
  (except via the `/health` endpoint's active-call count). The
  dashboard (`api/dashboard.ts`) queries DynamoDB for historical
  records, not live state.
- The `sessionCount()` and `peakSessionCount()` helpers are
  per-instance. A multi-instance WS tier needs to sum them for a
  global view — left to the load balancer / monitoring layer.

## Alternatives considered

**Move session to Redis.** The textbook answer. Rejected for all
four reasons above. The README TODO has been deleted and the
`src/utils/sessions.ts` doc block explains why.

**Hybrid: hot path in-memory, cold path in Redis.** Keep
`touchSession()` local but write session snapshots to Redis on
creation / completion. Possible in the future if we need live
cross-instance dashboarding, but adds complexity with no current
caller. Noted but not built.

**Active-call index in KV.** Separate from the session store:
store a `callSid → instance-hostname` map in Redis so cross-instance
operations (e.g. "kill this call") can find the right WS host to
send a termination signal to. This IS a good idea but has no
current caller; it's a future extension of the KV abstraction from
ADR-004 when we need it.
