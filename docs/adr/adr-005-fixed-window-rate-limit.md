# ADR-005: Fixed-window rate limiter over sliding-window

**Status:** Accepted — shipped in PR #5.

## Context

We need rate limits on `POST /call/outbound` (primary: prevent
bill fraud from a leaked API key) and `/records/*` (secondary:
prevent DynamoDB scan amplification from a leaked key).

Three standard algorithms:

1. **Fixed window.** Align counters to a wall-clock interval
   (UTC minute, UTC hour). Simple, one counter per window, one
   KV operation per request.
2. **Sliding window.** Track individual request timestamps, count
   how many fall within the last N seconds. Accurate but expensive
   — typically a sorted set with one entry per request.
3. **Token bucket.** Amortize across time with a refill rate.
   Accurate, nice burst behavior, moderately complex.

## Decision

Use **fixed windows** with two buckets per client key (per-minute
and per-hour). Implementation in `src/core/rateLimit.ts`:

- Keys: `rl:<namespace>:<clientHash>:m:<minuteBucket>` and
  `rl:<namespace>:<clientHash>:h:<hourBucket>`.
- On each request, `incrBy` both counters (pipelined — see ADR-004
  and audit M-1). If either exceeds its limit, return 429 with
  `Retry-After` pointing at the end of the tripped window.
- On KV errors, **fail open**.

Client key hashing uses FNV-1a 32-bit. Documented collision
boundary: ~65k distinct keys before a birthday collision. For the
current callers (1 API key, or low-cardinality client IDs) this is
irrelevant; the upgrade path to SHA-256 is documented in-situ.

## Consequences

**Benefits:**

- One `incrBy` per window per request (two total when both minute
  and hour are enabled). Cheap on Upstash and near-free on MemoryKv.
- Counters align on UTC wall-clock boundaries, which makes them
  easy to reason about in logs and dashboards.
- Buckets self-expire via TTL — no separate reaper needed.

**Costs:**

- **Boundary burst risk:** a client can send 2× the nominal limit
  by hammering at the very end of one window and the very start of
  the next. For a 30/min limit, up to 60 requests in 2 seconds
  spanning the minute boundary. Acceptable for this use case —
  the hour window bounds the total blast radius to 500 requests
  regardless.
- **Slight over-counting at the limit edge.** If a request hits
  the limit exactly, the counter is incremented but the request
  is rejected. This is correct bill-protection behavior — the
  alternative ("decrement on reject") adds a KV write for nothing.

## Alternatives considered

**Sliding window via sorted sets.** Accurate per-request, no
boundary burst. Rejected because:
- Requires `ZADD` + `ZREMRANGEBYSCORE` + `ZCARD` per request (3 KV
  ops vs. 1).
- The accuracy doesn't matter for bill protection — fixed window's
  worst case is still bounded.
- Adds storage proportional to request volume (each request's
  timestamp lives in Redis for the window duration).

**Token bucket with leaky refill.** The most technically correct
answer for smooth traffic shaping. Rejected because the operator
mental model is harder ("my 30/min limit is actually a refill
rate of 0.5/sec with a bucket of 30") and because bill protection
doesn't benefit from traffic shaping — it benefits from hard caps.

**Rate limit via Twilio's built-in concurrency limits.** Twilio
will cap parallel outbound calls at the account level, but:
- It's expensive (Twilio bills for attempted calls).
- It doesn't protect against the scan-amplification surface on
  `/records/*`.
- It has no per-API-key dimension.

**No rate limit.** Rejected explicitly in the security checklist.
A leaked `OUTBOUND_API_KEY` without rate limits is an unbounded
bill exposure.

## See also

- `src/core/rateLimit.ts` — implementation.
- `src/core/outbound.ts` `checkOutboundRateLimit` — /call/outbound wiring.
- `src/core/records.ts` `checkRecordsRateLimit` — /records wiring.
- `tests/rateLimit.test.ts` — window rollover, client isolation,
  fail-open, atomic pipeline tests.
