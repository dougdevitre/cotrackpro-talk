# Code review — Vercel hosting optimization branch

**Scope:** everything merged in PR dougdevitre/cotrackpro-talk#4 (the
Vercel hybrid split) plus the rate-limit / KV / cost-rollup commit
`f38e910` on the same branch.

**Reviewer:** Claude (self-review of code I wrote in this session, plus
the surrounding code I touched). I have tried to be honest — I'm
flagging issues in code I introduced, not just pre-existing problems.

**How to read this:** findings are grouped by severity. `file:line`
references let you jump to each one. Issues marked **[action]** are
things I think should be fixed before the next production deploy;
**[discuss]** means there's a judgment call; **[nit]** is cosmetic.

## Fix status

Items marked **[FIXED in <commit>]** were addressed in a follow-up
commit after this review was written, with unit tests added to cover
the new behavior. The finding text is left in place so the rationale
stays visible.

---

## Severity summary

| Severity | Count | Fixed | Short description |
|---|---|---|---|
| Critical | 2 | 2 | Unvalidated `to` phone number on /call/outbound; timing-safe compare missing on Bearer auth |
| High | 3 | 3 | No upper bound on `parseLimit`; role/status strings cast without validation; incoming TwiML role is user-controlled but role enum is not |
| Medium | 5 | 0 | Rate-limit atomicity across minute+hour; Vercel rewrite query-string fragility; no idempotency key on outbound calls; 4-byte FNV collisions at scale; MemoryKv has no sweep |
| Low | 4 | 0 | Minor typing looseness; dead `log` declaration in places; unused import; `details` field type bleeds across error variants |
| Nit | 3 | 0 | Test helper mocking wart; comment inconsistencies; `_setKvForTests` naming |

---

## Critical

### C-1. `to` phone number on /call/outbound is not validated [action] **[FIXED]**

**File:** `src/core/outbound.ts:119-166`

**Fix:** New module `src/core/phoneValidation.ts` implements strict
E.164 validation + a configurable ISO country allow-list
(`OUTBOUND_ALLOWED_COUNTRY_CODES`, default `"US,CA"`, `"*"` to
disable). `initiateOutboundCall` now rejects with 400 on non-E.164
input or a disallowed country before touching the Twilio REST API.
Tests in `tests/phoneValidation.test.ts` cover both the format and
allow-list axes, including the UAE premium-rate scenario from the
original finding.

`initiateOutboundCall` takes `body.to` and passes it straight to
`twilioClient.calls.create({ to, ... })`. There is no format check, no
country allow-list, and no length limit. An attacker (or a compromised
Bearer token) can dial premium-rate international numbers and run up a
substantial bill before the per-hour rate limit trips.

The per-hour cap is 500 by default — at $5/min for a premium rate
number that's up to $2,500 in an hour.

**Suggested fix:** at minimum, use `libphonenumber-js` (or write a
10-line E.164 regex) to reject anything that isn't `^\+[1-9]\d{1,14}$`.
Better: allow-list country codes via a new env var
`OUTBOUND_ALLOWED_COUNTRY_CODES="US,CA"`. This is a standard
anti-bill-fraud check for any outbound telephony API and is cheap to
add.

Related: `handlers/outbound.ts` and `api/call/outbound.ts` both just
forward `body` to `initiateOutboundCall` — the fix belongs in the core
function, not in each adapter.

### C-2. Bearer token comparison is not timing-safe [action] **[FIXED]**

**Files:**
- `src/core/outbound.ts:59` — `authHeader !== \`Bearer ${env.outboundApiKey}\``
- `src/core/records.ts:36` — same pattern

**Fix:** New module `src/core/auth.ts` exports `bearerMatches`, a
wrapper around `crypto.timingSafeEqual` that also length-guards (so
callers don't have to). Both `authorizeOutbound` and
`authorizeRecords` now delegate to it. Tests in `tests/auth.test.ts`
cover the matching, length-mismatch, missing-prefix, and unicode
paths.

JavaScript `!==` on strings short-circuits on the first differing
character. With a sufficiently chatty attacker this leaks the token
one character at a time over the network. The risk is low in practice
(JITted string compare is fast, network jitter is high) but the fix is
free: `crypto.timingSafeEqual`.

**Suggested fix:** add a helper in `src/core/auth.ts`:

```ts
import { timingSafeEqual } from "node:crypto";

export function constantTimeBearerMatch(
  authHeader: string | undefined,
  expected: string,
): boolean {
  if (!authHeader) return false;
  const provided = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";
  // Zero-pad to equal length to avoid throwing on mismatched sizes,
  // then compare. timingSafeEqual returns false for length mismatch.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

Then `authorizeOutbound` and `authorizeRecords` both use it.

---

## High

### H-1. `parseLimit` has no upper bound [action] **[FIXED]**

**File:** `src/core/records.ts:70-74`

**Fix:** `parseLimit` now clamps at `MAX_RECORDS_LIMIT = 100`
regardless of the caller's input. The fallback is also clamped in
case a future caller passes a large fallback. Test in
`tests/records.test.ts` verifies the cap.

`parseLimit` accepts any positive integer, including `?limit=10000000`.
That triggers a DynamoDB scan for ten million records, which is
expensive AND (because DynamoDB paginates at 1MB) effectively times
out the serverless function. This is a DoS amplifier.

**Suggested fix:**

```ts
export function parseLimit(raw: string | undefined, fallback: number): number {
  const MAX = 100;
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX);
}
```

The tests in `tests/records.test.ts:80-82` already document the
fallback behavior; adding a cap is a one-line change.

### H-2. Role / status query params are cast without validation [action] **[FIXED]**

**Files:**
- `src/core/records.ts:123` — `listCallsByRole(role as CoTrackProRole, ...)`
- `src/core/records.ts:154` — `listCallsByStatus(status as CallStatus, ...)`

**Fix:** New module `src/core/enumValidation.ts` exports
`VALID_ROLES`, `VALID_STATUSES`, `isValidRole`, `isValidStatus`, and
a lenient `normalizeRole` for the TwiML handlers. `listRecordsByRole`
and `listRecordsByStatus` now 400 on unknown values instead of
silently casting. `buildIncomingTwiml` normalizes the incoming role
via `normalizeRole` (closes H-3 in the same commit). Tests in
`tests/enumValidation.test.ts` cover the type predicates,
normalization, and case sensitivity.

The string comes from URL path segments the caller controls. Casting
it to the enum type is a lie — there's no runtime check. DynamoDB
won't return anything for `/records/by-role/administrator`, so the
query returns empty rather than 400. The API contract says these are
enum values, so the wrong response code confuses clients.

**Suggested fix:** a small whitelist:

```ts
const VALID_ROLES: readonly string[] = [
  "parent", "attorney", "gal", "judge", "therapist",
  "school_counselor", "law_enforcement", "mediator", "advocate",
  "kid_teen", "social_worker", "cps", "evaluator",
];

if (!VALID_ROLES.includes(role)) {
  return { ok: false, status: 400, body: { error: "Unknown role" } };
}
```

(Or derive the list from the type via a const tuple to keep them in
sync — see the existing `src/types/index.ts:138-151`.)

### H-3. `role` query param on /call/incoming is reflected into TwiML without an enum check [discuss] **[FIXED]**

**File:** `src/core/twiml.ts:61-83` (via `api/call/incoming.ts:45` and
`src/handlers/twiml.ts:65`)

**Fix:** `buildIncomingTwiml` now normalizes the role via
`normalizeRole` from `src/core/enumValidation.ts` before stamping it
into the TwiML. Unknown roles get logged and fall back to "parent"
rather than propagating into the call session. `escapeXmlAttr` is
still active as a secondary defense. Test in `tests/twiml.test.ts`
covers normalization AND verifies that `callerNumber` (which is NOT
normalized) is still escape-defended.

Any string the caller supplies via `?role=xxx` becomes a Stream
parameter in the TwiML. `escapeXmlAttr` prevents XML injection, but
the role then flows into `createSession(callSid, streamSid, role)` in
`callHandler.ts`, which looks up a voice via `getVoiceId(role)` in
`config/voices.ts`. If the role is unknown the lookup either falls
back to a default or returns undefined, which could crash the
ElevenLabs WS handshake.

This is an edge case — Twilio's webhook URL is controlled by you, not
by callers, so in practice an unknown role only happens if you
misconfigure the webhook. But it's brittle.

**Suggested fix:** in `buildIncomingTwiml`, normalize unknown roles to
"parent" with a log line. Same `VALID_ROLES` constant as H-2.

---

## Medium

### M-1. Rate limit minute+hour check is not atomic [discuss]

**File:** `src/core/rateLimit.ts:84-105`

The minute INCRBY and hour INCRBY are separate KV calls. If a request
trips the hour limit, the minute counter has ALREADY been incremented
(we consumed a minute slot for a request that couldn't succeed). This
causes slight over-counting. At 30/min limits the over-count is <5%.

For Upstash, the fix is a pipelined multi-exec; for MemoryKv it's a
no-op since the store is synchronous. Not worth implementing unless
observability shows the over-count mattering.

Also related: if the minute counter INCRBY succeeds but the hour
counter INCRBY throws (partial KV outage), `checkRateLimit` falls into
the catch block and returns "allowed: true" (fail open). The minute
counter is now one off. Self-healing after 65 seconds. Acceptable.

### M-2. Vercel rewrite + signed URL is fragile [discuss]

**Files:**
- `vercel.json:10-17`
- `api/call/incoming.ts:45-53`
- `api/call/status.ts:27-37`

The Twilio signature validators reconstruct the signed URL from the
public path (`/call/incoming`) plus the original query string from
`req.url`. This assumes Vercel's rewrite:

1. Preserves query params verbatim in `req.url`
2. Does not reorder them
3. Does not URL-decode and re-encode them

Vercel's behavior matches (1) and (2) today. If it ever changes (3)
— re-encoding `+` as `%2B` for example — signature validation would
silently start 403'ing every webhook in prod because Twilio signed the
original encoding.

**Suggested fix:** add an end-to-end integration test that sends a
real Twilio webhook through `vercel dev` and asserts the signature
passes. Alternatively, stash the original path in an internal header
via the rewrite and read it back in the handler (Vercel supports
header-passing via rewrites) so we never have to reconstruct.

Lower priority but worth a regression guard.

### M-3. No idempotency key on outbound Twilio calls [nit]

**File:** `src/core/outbound.ts:135-141`

If a client retries a POST /call/outbound due to a network blip, a
second call is dialed. Twilio supports idempotency keys to make this
safe. We don't pass one. For a 30/min limit and low-traffic API this
is fine, but on the cost-amplification hit list it's an easy win.

### M-4. 32-bit FNV hash collision risk at scale [discuss]

**File:** `src/core/rateLimit.ts:132-140`

`hashClientKey` uses FNV-1a 32-bit, which gives ~65k distinct keys
before a 50% collision probability (birthday bound). For a single API
key (which is the current use) this is irrelevant. If the rate
limiter is ever extended to bucket per-IP or per-tenant for a large
customer base, upgrade to SHA-256 (first 8 hex chars still work as a
KV key). Document this limit.

### M-5. MemoryKv has no background expiry sweep [discuss]

**File:** `src/services/kv.ts:56-98`

Expired entries are only dropped on read. A callsite that writes keys
with TTLs but never reads them would grow the Map forever. The rate
limiter IS a frequent reader, so this won't bite in practice, but a
future cron/batch caller could trip it.

**Options:**
- Add a lazy sweep every N writes (cheap, bounded)
- Add a setInterval sweep (unref'd)
- Document the constraint and move on

Lowest priority.

---

## Low

### L-1. `OutboundResult` error body type is over-permissive [nit]

**File:** `src/core/outbound.ts:38-48`

```ts
body: {
  error: string;
  details?: string;
  retryAfterSeconds?: number;
};
```

Only 429 sets `retryAfterSeconds`, only 500 sets `details`. The type
permits all statuses to set all fields. Not a bug but a missed
opportunity for a discriminated union: `{ status: 429; body: { error; retryAfterSeconds } } | { status: 500; body: { error; details } }`
etc. Costs ~30 lines for type-driven correctness.

### L-2. `log` declared at top of `src/core/records.ts:20` is only used in one place [nit]

Not worth removing — the pattern matches the other `core/*` files. Nit.

### L-3. Type cast in `handlers/outbound.ts:15` imports unused `FastifyReply` [nit]

**File:** `src/handlers/outbound.ts`

`FastifyReply` is imported twice (once as a type at line 11, once at line 15).
One is redundant. Typecheck passes because duplicate type imports are
allowed.

Actually looking again — the file imports `FastifyInstance` and (separately)
`FastifyReply`. Both are used. Not a duplicate. Disregard this one.

### L-4. Unused import in `src/handlers/records.ts:17` [nit]

`FastifyRequest` is imported but only used as a parameter type in one
hook. Fine — that's a legitimate use. Nit only because the two-line
import could be single-line.

---

## Nits

### N-1. `tests/httpAdapter.test.ts:38-48` has a dead local [nit]

`mockRequest` builds an unused `Readable.from(opts.body ?? "")` and
discards it with `void stream;`. Left over from a first-pass
implementation. Harmless but can be removed — the `stream2` object is
the real mock.

### N-2. `_setKvForTests` vs `_resetKvForTests` naming inconsistency [nit]

**File:** `src/services/kv.ts:197-210`

One uses `for` (`_setKvForTests`), one uses the same suffix but reads
differently (`_resetKvForTests`). Bikeshed; consistent underscore prefix
is what matters and that's already in place.

### N-3. README diagram has a typo wall [nit]

Not in this branch — pre-existing. `README.md` "Data Flow (per utterance)"
uses box-drawing chars that break in narrow terminals. Pre-existing;
don't fix in this PR.

---

## What's well-done

Not every review needs to be a list of complaints. Things I think are
right:

- **`src/core/` split is clean.** Pure functions, structured results,
  zero framework coupling. The Fastify and Vercel adapters really are
  thin. This paid off immediately: the test suite hits the core
  modules directly without spinning up either framework.
- **Fail-open on KV error** in the rate limiter is the right call. A
  rate-limiter outage that blocks real traffic is strictly worse than
  a brief window of unrate-limited traffic.
- **The in-memory session store decision** (documented in
  `src/utils/sessions.ts:1-42`) is architecturally correct for a
  real-time voice pipeline. Resist pressure to "make it Redis" — it's
  the wrong answer.
- **TwiML escaping** (`src/core/twiml.ts:19-27`) correctly escapes `&`
  first. That order matters and is easy to get wrong.
- **Vercel signature URL reconstruction** correctly uses the public
  path instead of `req.url`. This is subtle — see M-2 — and I want to
  call out that it was thought about up front rather than discovered
  by a 403 loop in prod.
- **Test coverage is focused where it matters.** 118 tests hit the
  pure core modules (rate limiter math, cursor encode/decode, TwiML,
  KV TTL, aggregation). Integration-ish modules (Twilio REST,
  DynamoDB, WS pipeline) are deliberately not unit-tested because the
  tests would be either unreliable or dishonest.

---

## Priority for action items

**UPDATE:** The Critical (C-1, C-2) and High (H-1, H-2, H-3) items
were all fixed in a follow-up commit. Each fix shipped with unit
tests. The review text above is preserved for historical context and
to keep the rationale visible in code review.

Remaining to address (not yet implemented):

- **M-1** — Rate limit minute+hour atomicity. Low priority until
  observability shows it mattering.
- **M-2** — Vercel rewrite + signed URL fragility. Adds an integration
  test rather than a code fix; deferred.
- **M-3** — Idempotency key on Twilio outbound calls. Cheap to add;
  deferred because the rate limit already caps blast radius.
- **M-4** — 32-bit FNV collision risk. Document-only at current scale.
- **M-5** — MemoryKv background sweep. Not observed in practice.
- **L-1 through L-4** and the nits are cosmetic.

---

*— Claude, `claude-opus-4-6`, self-review + follow-up fixes, session
`01NV6XNwYwEmSQDmxnhM6ezi`.*
