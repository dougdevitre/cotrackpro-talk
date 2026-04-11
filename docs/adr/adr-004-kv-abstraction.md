# ADR-004: KV abstraction with in-memory default + Upstash REST

**Status:** Accepted — shipped in PR #5; pipeline method added in PR #6.

## Context

Several features need small, short-TTL shared state:

- **Rate-limit counters** for `/call/outbound` and `/records/*`
  (fixed-window minute + hour buckets — ADR-005).
- **Idempotency cache** for `POST /call/outbound` replays (ADR-003).

In single-host deployments, an in-process Map is sufficient. In the
hybrid deployment (ADR-001), both Vercel functions and the WS host
need to see the same counters — otherwise a rate-limited caller
could just round-robin between tiers to get past limits, and an
idempotency retry that happens to land on a different function
invocation would see an empty cache.

We also wanted to ship without adding an npm dependency if possible.

## Decision

Introduce a small `KvStore` interface in `src/services/kv.ts` with
four operations: `get`, `set`, `incrBy`, `delete`, and `pipeline`.
Two backends:

1. **`MemoryKv`** — in-process `Map<string, {value, expiresAt}>`.
   Amortized expiry sweep every 128 writes (ADR-004 extension in
   PR #6 — audit M-5). Per-process, zero setup. Default when
   `KV_URL` / `KV_TOKEN` aren't set.

2. **`UpstashKv`** — HTTP client against the Upstash Redis REST
   endpoint. Vercel KV is API-compatible with Upstash REST, so the
   same code handles both. Selected automatically when `KV_URL` +
   `KV_TOKEN` are set. Uses global `fetch()` — zero npm deps.

The interface is deliberately narrow. We didn't ship a full Redis
client — just the specific operations the rate limiter and
idempotency cache need. When a new caller needs something else
(e.g. `zadd`, `hget`), we extend the interface on demand. YAGNI
until it isn't.

## Consequences

**Benefits:**

- Zero new npm deps. `fetch()` is built into Node 20.
- Single-host deployments can skip the KV setup entirely.
- Hybrid deployments get Upstash / Vercel KV by just setting two
  env vars; no code changes.
- Tests can swap in a custom `KvStore` stub (`_setKvForTests`) to
  exercise fail-open paths without network mocking.

**Costs:**

- The interface is narrow. Adding a new primitive requires:
  1. Extend the `KvStore` interface
  2. Implement in `MemoryKv`
  3. Implement in `UpstashKv`
  4. Add the `ThrowingKv` test stub method
  This is 4 touch points instead of 1, but each is small.
- `UpstashKv.incrBy` intentionally does NOT use EXPIRE NX for the
  pipelined path because Upstash pipelines don't support
  conditional commands. We accept that the TTL is set on every
  write, which causes an innocuous ~65s overrun on rate-limit
  buckets. Documented in the kv.ts pipeline method.
- No pub/sub. Not needed yet.

## Alternatives considered

**`ioredis` or `redis` npm client.** Industry standard, feature-rich.
Rejected: adds a runtime dep, doesn't work cleanly on Vercel's
serverless runtime, and we don't need the feature richness.

**`@upstash/redis` SDK.** Official Upstash REST client with TypeScript
types. Rejected: adds a dep, and the 60 lines of fetch-based code in
`UpstashKv` does everything we need.

**Vercel KV SDK.** Vendor-locked to Vercel. Rejected: we want the
same code to work on the WS host (which is Fargate/Fly/Render, not
Vercel). Vercel KV's API-compatibility with Upstash means our
Upstash client works against Vercel KV anyway.

**Leave everything in-memory and require sticky session routing.**
Rejected: rate-limit counters and idempotency cache need to be seen
by both tiers, and sticky routing doesn't help across tiers.

## Pipeline extension (PR #6)

Audit M-1 added a `pipeline(ops: PipelineOp[])` method to the
interface. The rate limiter previously did two separate `incrBy`
calls (minute then hour) — a partial failure between them left the
minute counter bumped while the hour counter was unchanged. The
pipeline ships both ops as one atomic unit:

- MemoryKv: sequential in-process calls (already atomic in
  single-threaded JS).
- UpstashKv: one POST to the `/pipeline` REST endpoint. Upstash
  runs the commands sequentially on one connection, so partial
  state is impossible.

## See also

- `src/services/kv.ts` — implementation.
- `src/core/rateLimit.ts` — primary caller.
- `src/core/idempotency.ts` — second caller.
- `tests/kv.test.ts` — 30+ cases covering both backends.
