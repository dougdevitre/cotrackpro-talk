# ADR-001: Hybrid Vercel HTTP + long-running WebSocket split

**Status:** Accepted — shipped in PR #4.

## Context

CoTrackPro Voice Center has two kinds of traffic:

1. **Short, stateless HTTP requests** — the Twilio webhook that
   returns TwiML (~100ms), the outbound call initiation, the records
   REST API, the cron cost rollup, and the admin dashboard. All of
   these are request → response flows that hold no state between
   calls and benefit from global edge delivery.

2. **Long, stateful WebSocket sessions** — the Twilio Media Stream
   carrying bidirectional audio for the duration of a phone call.
   These sessions live for seconds to hours, hold ~20KB of
   per-session state plus open Anthropic and ElevenLabs streams, and
   are fundamentally incompatible with serverless function timeouts.

The first group fits serverless hosting (Vercel) perfectly. The
second cannot run on serverless at all.

## Decision

Deploy as **two cooperating tiers** sharing one repo and one
`src/core/*` framework-agnostic layer:

- **HTTP tier on Vercel.** `api/*.ts` files route to the same
  framework-agnostic core functions the Fastify handlers use. Scale
  to zero, global edge, preview deployments per PR, zero cert
  management.
- **WebSocket tier on a long-running host.** Fastify + `ws` running
  on Fargate, Fly, Render, or Railway. Single routing target for
  `wss://ws.example.com/call/stream`.

The TwiML returned by the Vercel webhook points `<Stream url>` at
the WS host, not Vercel. That redirect is the whole mechanism —
Twilio's HTTP traffic hits the cheap tier, and Twilio's Media
Stream hits the expensive tier. One repo, two deploy targets, one
source of truth for business logic.

Single-host mode (one Fastify process serves both) remains
supported for dev and small-scale production. The split is opt-in
via the `API_DOMAIN` + `WS_DOMAIN` env vars; setting only
`SERVER_DOMAIN` falls back to the single-host shape.

## Consequences

**Benefits:**

- HTTP tier cost drops to zero at idle (Vercel bills per invocation).
- Twilio webhook latency improves via global edge.
- Preview deployments per PR for the HTTP tier — every branch is
  testable against Twilio without merging.
- TLS + cert rotation fully managed by Vercel.
- WS host can be sized purely for WebSocket workload, not HTTP RPS.

**Costs:**

- Two deploy targets instead of one. More operational surface area.
- `Idempotency-Key` header and rate-limit counters need to be
  shared across both tiers (hence ADR-004 on the KV abstraction).
- Twilio signature validation had to be made rewrite-aware (see
  audit M-2 — the URL reconstruction uses a hardcoded public path
  because `req.url` is rewritten on Vercel).
- Minor `core/*` indirection cost. Framework adapters are thin but
  there's still a function call layer between "HTTP request
  arrived" and "business logic runs."

**Non-consequences:**

- Does NOT affect per-call $ cost. Anthropic + ElevenLabs + Twilio
  dominate the bill; hosting is a rounding error either way.
- Does NOT change the audio pipeline latency. The hot path is
  Claude ↔ ElevenLabs ↔ Twilio; none of that touches Vercel.

## Alternatives considered

**Single host (Fastify on one Fargate task).** The original shape.
Simpler ops, one deploy target. Rejected at scale because (a) the
HTTP tier can't scale to zero, (b) no per-PR preview environments,
and (c) cert + TLS management on the LB is unnecessary toil when
Vercel does it for free.

**WebSocket on Vercel Edge.** Vercel has edge functions that
support WebSocket upgrades, but only for short-lived edge-to-edge
WS (think chat, not phone calls). Serverless function time limits
make this a non-starter for voice calls that can run for hours.

**Vercel Functions only + fire-and-forget audio to a separate
service.** Could use Vercel Functions for HTTP + call into an
audio-processing service via HTTP or message queue for each
utterance. Too many round trips; the audio hot path needs
sub-100ms turn-around and any HTTP indirection kills that.

**AWS ECS + API Gateway.** Fargate for WebSocket + API Gateway
for HTTP. Comparable to what we built, but more YAML, more
cert-management toil, and API Gateway's per-request pricing is
worse than Vercel's for low-volume HTTP traffic. No preview envs.
