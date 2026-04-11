# ADR-008: Circuit breakers on external services — deferred

**Status:** Accepted — deferred with criteria for when to build.

## Context

The audio hot path calls three external services synchronously
from inside a call:

1. **ElevenLabs STT** (WebSocket).
2. **Anthropic Claude** (streaming HTTP).
3. **ElevenLabs TTS** (WebSocket).

Plus one asynchronously:

4. **CoTrackPro MCP** (tool calls during Claude turns).

When one of these is slow or wedged, the call pays the latency
cost. Audit E-5 added **per-call timeouts** (45s Anthropic stream,
10s ElevenLabs connect, 30s MCP tool call) so no single upstream
can deadlock a call indefinitely. But **per-call timeouts are not
circuit breakers** — they fire once per call, they don't learn
from recent failures, and they don't fast-fail subsequent calls
when an upstream is known-broken.

A classic circuit breaker:

- Tracks recent failure rate per upstream.
- Trips open when the rate exceeds a threshold.
- Fast-fails subsequent calls until a probe request succeeds.
- Closes when the probe shows recovery.

This would let us skip the 45s Anthropic timeout when we already
know Anthropic has been timing out for the last 2 minutes — instead
of waiting 45s per call, we fast-fail immediately and play a
"please hold while I reconnect" message (or transfer to a human).

## Decision

**Defer.** Do not build circuit breakers until we have evidence
that the per-call timeouts are causing measurable user impact.

Concrete criteria for revisiting:

1. **p95 call latency** as measured by the SLOs in
   `docs/SLOs.md#inbound-webhook-latency` exceeds its target for
   one quarter, and the root-cause analysis points at one of the
   external services.
2. **More than 10% of calls per day** hit an E-5 timeout log line
   (`anthropic.stream.timeout`, `elevenlabs.connect.timeout`,
   etc.). Right now we have none in production so we don't know
   the baseline.
3. A specific incident occurs where fast-failing would have
   materially improved caller UX (e.g. a known 5-minute Anthropic
   outage where every call sat for 45s waiting to time out).

If none of those happen, the per-call timeout is sufficient.

## Consequences

**What we accept today:**

- During an upstream outage, every call pays the full timeout
  value before failing. For a 5-minute Anthropic outage at 30
  calls/min, that's 150 calls each eating 45 seconds of silence
  before giving up.
- No graceful degradation story. A call that hits a timeout gets
  whatever error the timeout raises; there's no "try the backup
  model" or "transfer to a human" fallback.
- Operators must manually respond to upstream outages by taking
  the product down (TwiML returns a maintenance message) if the
  per-call timeouts aren't acceptable.

**What we gain by waiting:**

- No premature optimization. Circuit breakers are complex —
  they have their own tuning parameters (failure rate, window,
  probe interval, max open time) and debugging them when they
  misfire is hard.
- When we do build it, we'll have real data on the failure
  patterns. "Anthropic timeouts are bimodal — 99% of calls are
  fast, 1% are >60s" implies a different circuit breaker than
  "Anthropic latency creeps from 2s to 45s over 10 minutes."
- We avoid the classic circuit-breaker failure mode where the
  breaker itself is the incident cause.

## Alternatives considered

**Ship a minimal circuit breaker now.** A threshold-based trip on
any of the three services. Rejected because:
- The tuning is guesswork without data.
- We'd need one breaker per service (so three new stateful
  things), each with its own KV key and failure window.
- Integration with the KV abstraction (ADR-004) would need new
  primitives for the breaker state machine.
- None of the three services has enough production incident
  history in this repo to calibrate against.

**Shipping retry logic instead.** Retries at the per-request level.
We already get this from the Anthropic SDK's built-in retry
(default 2 retries) and from the `AbortSignal.timeout` on the
ElevenLabs WS connect (one retry via the `.connect()` promise). A
circuit breaker would sit on top of these — it's a different tool
for a different problem (systemic vs. transient failures).

**Fall back to a secondary provider.** Configure a second TTS or
LLM provider and switch on failure. Rejected: the app's Claude
integration is quite specific (prompt caching, MCP tool calls,
streaming format) and a drop-in fallback would be a major rewrite.

## Trigger — add circuit breakers when any of these are true

- SLO burndown for call availability is upstream-dominated for
  two consecutive quarters.
- A single incident causes >30 minutes of elevated per-call
  latency from a known-broken upstream.
- The operator playbook starts including "if Anthropic is down,
  manually update this config to skip Claude and fall back to
  canned responses" — meaning we're doing manual circuit-breaking.

## See also

- `docs/RUNBOOK.md` — current upstream-outage triage steps.
- `src/services/anthropic.ts`, `src/services/elevenlabs.ts` —
  where the per-call timeouts live (audit E-5).
- `docs/SLOs.md#call-availability` — the metric that would trip
  the reconsider decision.
