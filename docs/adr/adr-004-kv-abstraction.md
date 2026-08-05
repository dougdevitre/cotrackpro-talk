# ADR-004: KV abstraction with in-memory default + Upstash REST

**Status:** Accepted — shipped in PR #5; pipeline method added in PR #6;
`DynamoKv` and the production backend choice recorded retroactively (see
"Third backend" and "Which backend production runs" below).

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

## Third backend: `DynamoKv` (recorded retroactively)

A third backend was added to `src/services/kv.ts` without an ADR entry,
and `docs/GO_LIVE-sms-voice-reminders.md` offers it as a co-equal option.
Recording it here so the tradeoff is written down rather than rediscovered:

3. **`DynamoKv`** — DynamoDB via the AWS SDK, partition key `pk`, native
   TTL on `expireAt` plus a defensive expiry filter on read (DynamoDB's
   sweep lags up to ~48h). Opt-in ONLY via `KV_BACKEND=dynamo`; `auto`
   never selects it, because it needs credentials and a provisioned table
   that memory/upstash deployments don't have.

Two properties of it are load-bearing and easy to miss:

- **`DynamoKv.pipeline` is NOT atomic.** DynamoDB has no values-returning
  batch, so it loops over N round-trips. `src/core/rateLimit.ts` states
  "the two counters either both move or neither does" — that claim holds
  for `MemoryKv` and `UpstashKv` and is **false** under `dynamo`. A
  throttle on the second op leaves the minute counter bumped and the hour
  counter untouched.
- **An expired-but-unswept counter row keeps its old `expireAt` and its
  old value**, so `get` returns null while `incrBy` continues an inflated
  stale count. Safe today only because every `incrBy` key is
  time-bucketed (`rl:<ns>:<client>:<m|h|d>:<bucket>`). A future
  non-bucketed counter would break this invariant.

## Which backend production runs: Upstash

The talk edge runs **Upstash**. The deciding factor is not performance —
it's that **the Vercel tier has no AWS credentials at runtime**. Nothing
in `scripts/sync-ssm-to-vercel.sh`, `scripts/push-env-login.sh`, or
`.github/workflows/vercel-env-sync.yml` mirrors `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, and Vercel serverless has no ambient IAM role,
so the SDK credential chain resolves nothing. Choosing `dynamo` would
mean hand-setting long-lived access keys in the Vercel dashboard, which
`adr-009-secret-rotation.md` advises against ("use IAM roles") and which
`sync-ssm-to-vercel.sh` warns against as a class ("Never set these in the
Vercel dashboard by hand").

Upstash needs no AWS credentials, has a genuinely atomic `/pipeline`, and
its credentials ride the existing SSM → Vercel pipeline as
`kv/url` → `KV_URL` and `kv/token` → `KV_TOKEN`.

`DynamoKv` stays in the tree as a supported option for an AWS-native
single-host deployment (where an instance/task role supplies credentials
and the non-atomic pipeline is the only real cost). It is not the
hybrid-deployment default.

## Misconfiguration must be loud

Every consumer of this store fails **open** — a KV throw is logged and
the caller proceeds. That is the right availability tradeoff, but it
means a store that isn't working produces no failed request, no alert,
and no user-visible error: just silently absent state. In the STOP
suppression case that is a compliance violation rather than a bug.

Two failure paths used to be entirely silent, and are now not:

- `KV_BACKEND=upstash` with a missing `KV_TOKEN` fell back to memory.
- A typo'd `KV_BACKEND` matched no branch, fell back to memory, **and**
  defeated `KV_URL`/`KV_TOKEN` — because the auto-upstash path requires
  the literal `"auto"`.

`planKvBackend()` now returns a structured `reason` distinguishing
"memory because that's the default" from "memory because your config is
broken", and warns naming the offending value. `describeKvBackend()`
reports what was configured; `probeKv()` round-trips a canary key to
report whether it actually **functions** — the gap between those two is
where `DynamoKv` fails, since it builds a client without resolving
credentials and looks healthy until the first real write.

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
- `src/core/rateLimit.ts` — rate-limit counters.
- `src/core/idempotency.ts` — replay cache.
- `src/core/consent.ts` — STOP suppression list (the compliance-critical
  caller; an opt-out that doesn't persist is a TCPA/A2P problem).
- `src/core/voiceOutbound.ts` — pending `<Play>` line, handed off between
  the call-placing request and Twilio's later audio fetch. Structurally
  broken on a per-process backend.
- `src/core/smsConversation.ts` — conversational-SMS thread memory.
- `src/core/webConsent.ts` — proof-of-consent records for the opt-in form.
- `tests/kv.test.ts` — ~30 cases, `MemoryKv` only (the file says so).
- `tests/dynamoKv.test.ts` — `DynamoKv` class logic against a hand-written
  fake. Note the real AWS adapter (`realDynamoKvClient`) has no coverage.
- `tests/kvBackendSelection.test.ts` — the selection matrix and `probeKv`.
