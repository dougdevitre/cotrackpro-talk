# ADR-003: Client-side idempotency via `Idempotency-Key` header

**Status:** Accepted — shipped in PR #6 (audit M-3).

## Context

A client that retries `POST /call/outbound` because the first
response was lost to a network blip used to dial the call twice.
The rate limiter bounds the blast radius (30/min by default) but
doesn't actually prevent a duplicate dial when the client
legitimately retries a failed request.

Twilio's Voice REST API does not have a native idempotency header.
Twilio Messaging does, but `calls.create()` doesn't. So we have to
implement the pattern ourselves.

## Decision

Implement **client-side idempotency** the way Stripe and Twilio
Messaging do it:

1. Client sends an `Idempotency-Key: <any string>` header on
   `POST /call/outbound`.
2. The server hashes the key, checks a KV cache under
   `idem:outbound:<hash>`, and:
   - **Cache hit** → return the cached response with
     `X-Idempotent-Replay: true`. The real action does not re-run.
   - **Cache miss** → run the action, cache the structured
     response for 24 hours, return it with
     `X-Idempotent-Replay: false`.
3. Key validation: 1-256 chars, printable ASCII only, hashed with
   FNV-1a for a bounded KV key name. Malformed keys return 400
   rather than being silently dropped — a client that asked for
   idempotency and got it silently ignored would be a bug waiting
   to happen.
4. Cache **success** and **deterministic 400s** (invalid phone
   number, disallowed country, bad key format). Do NOT cache
   transient 500s — the whole point of retries is to get past a
   transient failure, and a cached 500 defeats that.

## Consequences

**Benefits:**

- Double-dial from network retries is no longer possible within the
  24-hour window.
- Deterministic validation failures are cheap to retry — they replay
  from cache instead of re-burning rate-limit budget.
- The pattern composes with the rate limiter: idempotent replays
  don't consume rate limit slots (the replay is served before the
  rate limiter sees the request).

**Costs:**

- Cache storage. Each cached entry is ~500 bytes × 24h TTL × traffic
  volume. At 500 calls/day that's 250 KB/day, well within any KV
  free tier.
- Race window: two concurrent requests with the same key can both
  miss the cache and both proceed. Documented in
  `src/core/idempotency.ts` as acceptable because (a) clients don't
  normally send concurrent requests with the same key — the whole
  point of idempotency is to retry *after* the first response
  failed — and (b) the rate limiter bounds the blast radius.
- Client API surface grows by one header. Documented in README.

**Interaction with the discriminated union:** when `L-1` (PR #7)
refactored `OutboundResult` into a discriminated union, the
`IdempotencyKeyError` shape had to stay width-compatible with
`OutboundBadRequest`. It does — required `details: string` is
assignable to optional `details?: string` — so the
`return keyParse;` short-circuit still typechecks.

## Alternatives considered

**Rely on the rate limiter alone.** 30/min does bound double-dial
blast radius but doesn't solve the retry-after-network-blip case —
a client that retries once within the minute gets two calls, both
legitimate-looking to the rate limiter. Rejected: bounds blast
radius but doesn't fix the primary complaint.

**Server-generated request IDs.** Have the server assign a UUID on
first request and return it; client passes that back on retry.
Rejected because the first request has to succeed for the client to
get the ID, which is exactly the scenario idempotency exists to
protect. Also diverges from the industry-standard Stripe pattern.

**Redis SETNX for atomic first-claim.** Use `SET key value NX EX 24h`
to atomically claim the idempotency key. Rejected because it
requires a second KV round-trip (SETNX then update with real
result), adds complexity, and the race window it closes is
theoretical for this endpoint.

**Twilio native idempotency.** Twilio would add this to Voice REST
and we'd consume it. Rejected: they haven't, and we can't wait.

## See also

- `src/core/idempotency.ts` — implementation.
- `src/core/outbound.ts` — wiring into `initiateOutboundCall`.
- `tests/idempotency.test.ts` — 15 cases covering header validation
  and cache behavior.
- ADR-004 — the KV abstraction the cache rides on.
