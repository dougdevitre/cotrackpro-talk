# ADR-006: Single-tenancy boundary and multi-tenant migration path

**Status:** Accepted — current shape. Migration path documented but
not implemented.

## Context

The application currently serves exactly one tenant (CoTrackPro).
All of the following are single-valued global state:

- `OUTBOUND_API_KEY` — one Bearer token.
- `TWILIO_PHONE_NUMBER` — one originating number.
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` — one Twilio account.
- `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` — one account each.
- DynamoDB table has no tenant partition.
- Rate limit counters and idempotency cache have no tenant dimension.
- Dashboard and cost records are global.

This is deliberate. Premature multi-tenancy is one of the more
expensive forms of over-engineering.

## Decision

**Stay single-tenant until a real customer driver appears.** Do
not add tenant dimensions speculatively. When the need arrives,
use the migration path below.

When single-tenancy is no longer sufficient, the migration needs
to touch ~12 files. Here's the checklist:

### Required changes

1. **`src/config/env.ts`** — introduce a `tenants.json` or similar
   config source (or per-request lookup via header/JWT). One env
   var per field becomes "lookup for current request's tenant."

2. **`src/core/auth.ts` + `bearerMatches`** — multi-key compare.
   Each tenant has a Bearer token; auth resolves which tenant
   this request belongs to.

3. **`src/core/rateLimit.ts`** — key rate-limit counters on
   `tenant:client` instead of just `client`.
   `hashClientKey(tenant + ":" + apiKey)` works but 32-bit FNV
   collision probability rises with cardinality — upgrade to
   SHA-256 (see M-4 in the code review).

4. **`src/core/idempotency.ts`** — namespace idempotency keys by
   tenant so two tenants can't collide on the same
   `Idempotency-Key` value.

5. **`src/utils/sessions.ts`** — add `tenantId` to `CallSession`.
   Concurrent-session cap (audit E-2) splits per-tenant.

6. **`src/services/dynamo.ts`** — add `tenantId` to the partition
   key or add a GSI for per-tenant queries. Existing records
   migration is non-trivial; plan for a backfill.

7. **`src/handlers/twiml.ts` + `api/call/incoming.ts`** — the
   `?role=` query param becomes `?tenant=...&role=...` OR tenant
   is resolved from the incoming phone number (which Twilio
   already provides).

8. **`src/handlers/outbound.ts` + `api/call/outbound.ts`** —
   outbound calls need to know which Twilio number to dial from.
   Today it's `env.twilioPhoneNumber`; tomorrow it's per tenant.

9. **`src/handlers/records.ts` + every `api/records/*.ts`** —
   records queries filter by tenant so Bearer auth to tenant A
   never sees tenant B's records.

10. **`api/dashboard.ts`** — dashboard displays only the
    authenticated tenant's calls. Today it shows everything.

11. **`api/cron/cost-rollup.ts` + `src/core/costRollup.ts`** —
    per-tenant rollups. The log line gains a `tenantId` field.

12. **Vercel Cron + Twilio Phone Numbers** — multi-tenant might
    want one phone number per tenant mapped to the same backend.
    That's a Twilio config problem, not a code one, but it needs
    to be designed alongside the code.

## Consequences

**Benefits of staying single-tenant:**

- Drastically simpler code. No per-request tenant resolution, no
  cross-tenant data isolation audits, no shared-key attack
  surface, no "tenant A's rate limit is starving tenant B" bugs.
- Dashboard and admin tools work without auth-scope scoping.
- DynamoDB schema is one table with a simple PK.

**What we accept:**

- Opening a second customer is a real project, not a config
  change. Concretely, the 12-file checklist above plus data
  migration + a multi-day QA cycle.
- Any speculative "could be multi-tenant later" work is
  acknowledged as out-of-scope. If a contributor adds a
  `tenantId` field to a type "just in case," this ADR is the
  pushback.

**Non-consequences:**

- Does not prevent running multiple deployments, each single-tenant.
  That's always possible — clone the repo, new env vars, new
  Vercel/Fargate deploy. For 2-3 customers this is probably
  cheaper than building multi-tenancy anyway.

## Alternatives considered

**Build multi-tenancy up front.** The textbook SaaS advice. Rejected
because (a) it adds concrete cost today with no concrete value,
and (b) the "shape" of multi-tenancy depends heavily on what the
actual customer ask looks like. Build for the customer you have.

**Deploy per customer.** As mentioned in "Non-consequences." This
is the pragmatic answer for 2-3 customers. Start here when the
second customer arrives and only build in-app multi-tenancy when
the deploy-per-customer model starts hurting.

## See also

- `docs/adr/adr-007-single-region-for-now.md` — similar
  "document-the-deferral" ADR for region scaling.
- `src/config/env.ts` — where the single-tenant assumptions live.
