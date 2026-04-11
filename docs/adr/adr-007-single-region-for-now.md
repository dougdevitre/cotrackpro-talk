# ADR-007: Single-region deployment and multi-region tradeoffs

**Status:** Accepted — single-region today. Multi-region deferred
with tradeoffs documented below.

## Context

Current shape: one WS host in one region, one Vercel project
(which is edge-distributed globally), one DynamoDB table in one
region, one Upstash Redis database in one region.

The Vercel HTTP tier is already global via the edge — TwiML webhook
latency is sub-100ms from anywhere. The WebSocket tier is not.

A caller in Europe hitting a US-east WS host pays ~100ms RTT on
every audio frame. That doesn't kill the call — Twilio's own RTT
is already in that ballpark — but it's noticeable. The audio loop
is:

```
caller → Twilio → WS host → STT / Claude / TTS → WS host → Twilio → caller
```

Every arrow adds latency. The WS host ↔ STT / Claude / TTS hop is
the interesting one because those three external services are
themselves in us-east-1 (Anthropic, ElevenLabs, OpenAI all have
us-east-1 as a primary region). Putting the WS host elsewhere saves
caller-to-WS RTT but costs WS-to-service RTT.

## Decision

**Deploy in a single region aligned with the external services'
primary region.** Today that's `us-east-1`. Accept the caller-side
RTT cost for non-US callers until the call volume in a specific
region justifies a regional deployment.

When a regional deployment is justified, the migration path below.

## Consequences

**Benefits:**

- One deploy target per tier. DNS, observability, on-call, cost
  accounting are all single-region-simple.
- Audio hot-path RTT to Anthropic / ElevenLabs is minimized, which
  is where the tightest per-frame budget lives.
- DynamoDB and Upstash are single-region, which removes a class of
  cross-region consistency bugs.

**What we accept:**

- Non-US callers see an extra 80-150ms of one-way latency on the
  Twilio → WS path, adding to the total conversational turn time.
  Still within the "comfortable" range for voice UX.
- Any region-wide AWS us-east-1 outage takes the WS tier with it.
  Vercel's HTTP tier stays up (global edge) but the audio pipeline
  stops. Runbook entry: "us-east-1 is down" → failover is manual,
  probably to us-west-2 with a Twilio URL flip. Not automated.

## Multi-region migration path

When a specific call-volume driver appears (e.g. a European
customer), the concrete changes:

1. **Twilio Regional Media** — Twilio supports media edge selection
   per phone number. Flip European numbers to their Frankfurt edge
   and they hit whichever region is closest.
2. **WS host in the new region** — one Fargate / Fly task in the
   target region, same Docker image, different env.
3. **WS DNS split** — `ws.example.com` becomes `ws-us.example.com`
   and `ws-eu.example.com`. TwiML generation chooses based on the
   caller's country code (already known from the Twilio webhook).
   Concretely: `src/core/twiml.ts:buildIncomingTwiml` gets a
   region parameter.
4. **DynamoDB Global Tables** — enable global replication on the
   `cotrackpro-calls` table. Adds cross-region replication latency
   (~1s) but writes can be regional. Acceptable for a cost record.
5. **Upstash Global Database** — Upstash has a global mode, or
   deploy per-region Redis with no cross-region consistency (rate
   limits are per-region).
6. **External service regional selection** — Anthropic, ElevenLabs,
   and MCP endpoints may or may not have EU regions at migration
   time. Check before committing to an EU WS host, or accept that
   the EU WS host has longer WS-to-service RTT (which may actually
   be worse than keeping it in us-east).

**Decision rule:** don't migrate until **at least one** of:

- A single region hosts > 30% of calls.
- Specific customer contract requires data residency.
- SLO burndown in a region exceeds error budget.

## Alternatives considered

**Multi-region from day one.** Rejected. The SaaS-architect
instinct is to spread across regions "for availability," but:
- For voice (bounded by Twilio + LLM latency), us-east is close
  to optimal for the primary external services.
- Multi-region doubles ops surface area and triples incident
  response complexity.
- Most regional outages are short enough that failover takes
  longer than the outage.

**Active-active across regions.** Even worse. Session state (per
ADR-002) is instance-local, so "active-active" would need
cross-region WebSocket routing which Twilio doesn't really do.

**Put the WS host on Cloudflare Workers.** Appealing for global
distribution but Workers don't support long-lived WebSockets like
Twilio Media Streams want. Same reason we're not using Vercel edge
functions for the WS route.

## See also

- `docs/adr/adr-001-hybrid-vercel-ws-split.md` — why the HTTP tier
  is already global via Vercel edge.
- `docs/SLOs.md` — per-region SLOs listed as future work.
