# ADR-009: Secret rotation story and the multi-key gap

**Status:** Accepted — documented current state, multi-key
rotation flagged as known gap.

## Context

The application has nine secrets:

| Secret | What it authenticates | Where it lives |
|---|---|---|
| `OUTBOUND_API_KEY` | Callers of `/call/outbound` and `/records/*` | Vercel env + WS host env |
| `TWILIO_AUTH_TOKEN` | Twilio webhook signature validation | Both tiers |
| `TWILIO_ACCOUNT_SID` | Twilio REST client for outbound calls | Both tiers |
| `ANTHROPIC_API_KEY` | Anthropic SDK | WS host only |
| `ELEVENLABS_API_KEY` | ElevenLabs WS + REST | WS host only |
| `CRON_SECRET` | Vercel Cron → `/api/cron/cost-rollup` | Vercel env only |
| `DASHBOARD_API_KEY` | Optional override for the dashboard | Vercel env (optional) |
| `KV_TOKEN` | Upstash / Vercel KV REST | Both tiers |
| AWS credentials | DynamoDB writes | WS host env (IAM role preferred) |

"Rotation" has two modes:

- **Planned rotation** — scheduled, no incident. Goal: rotate
  without dropping calls.
- **Emergency rotation** — suspected leak. Goal: invalidate the
  old credential immediately, accept brief unavailability.

Today, **zero-downtime rotation is only possible for the credentials
where the external service supports multiple active keys.** The
gap is `OUTBOUND_API_KEY`, which is a single string compared via
`bearerMatches` in `src/core/auth.ts`. Any rotation is
"atomic flip" — the new token doesn't work until every tier is
redeployed, and the old token stops working the instant one tier
is redeployed.

## Decision

**Document each secret's rotation procedure. Implement multi-key
support for `OUTBOUND_API_KEY` only when a real rotation pain point
surfaces.**

The current state is documented below. The future work to add
multi-key Bearer support is scoped but not built.

## Per-secret rotation procedures

### `OUTBOUND_API_KEY` — currently atomic, migration planned

**Today:**
1. Generate new token.
2. Update `OUTBOUND_API_KEY` in Vercel env.
3. Update `OUTBOUND_API_KEY` in WS host env.
4. Redeploy both tiers (roughly simultaneous).
5. Rotate the client's token to the new value.

Between steps 4 and 5 the client is broken. Not acceptable for
anything but emergency rotation.

**Future (documented; not built):**

Change `env.outboundApiKey: string` to
`env.outboundApiKeys: string[]` populated from a comma-separated
env var `OUTBOUND_API_KEYS`. The `bearerMatches` helper accepts
any of the provided keys. Rotation:

1. Generate new token.
2. Set `OUTBOUND_API_KEYS=old,new` and redeploy. Both tokens work.
3. Update the client to use `new`. Verify traffic cuts over.
4. Set `OUTBOUND_API_KEYS=new` and redeploy. Old token stops
   working.

This is the Stripe pattern. ~40 lines of code in `src/core/auth.ts`
+ a test update. Not built yet because there's no real client
rotating their keys today.

### `TWILIO_AUTH_TOKEN` — Twilio supports dual tokens

Twilio has a primary and secondary auth token. Signature
validation can check either.

Today `src/core/twiml.ts:validateTwilioSignature` checks only
`env.twilioAuthToken`. To support rotation:

1. In the Twilio console, set the secondary token to a new value.
   Twilio now signs with the primary but also accepts the
   secondary on validation.
2. Update `TWILIO_AUTH_TOKEN` in our env to the secondary.
   Redeploy. Validation now uses the secondary.
3. In the Twilio console, promote secondary to primary (or retire
   the old primary).

To make this clean we'd need `validateTwilioSignature` to accept
both the primary and secondary, which Twilio's SDK supports via
`validateRequestWithBody` with an array of tokens. Not built but
trivial to add (~10 lines).

### `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`

Both providers support multiple active keys on the same account.
Rotation:

1. Generate a new key in the provider's console.
2. Update our env to the new key.
3. Redeploy.
4. Revoke the old key in the provider's console.

Clean rotation with no active-call impact (existing calls are
using open WebSockets / streams that were authenticated at
connection time; new calls pick up the new key immediately).

### `CRON_SECRET`

Vercel Cron sets this header based on the env var. Rotation:

1. Update `CRON_SECRET` in Vercel env.
2. Redeploy.
3. Next cron invocation uses the new secret.

No in-flight cron concern because the daily cron runs for < 60s
and then exits.

### `KV_TOKEN`

Upstash and Vercel KV both support multiple tokens per database.
Rotation is the same as Anthropic/ElevenLabs: add new, update env,
redeploy, revoke old.

### AWS credentials

Don't use access keys in production — use IAM roles (Fargate task
role, Vercel built-in AWS integration). IAM role credentials
auto-rotate via STS. If you're still using access keys, rotation
is: new key, update env, redeploy, delete old.

## Emergency rotation runbook

For a suspected leak, the priority is **invalidate the old token**,
not continuity. Procedure:

1. **Identify the leaked secret.** Grep logs for unusual
   `Outbound call initiated` log lines, unexpected Anthropic
   billing, etc.
2. **Invalidate at the source first** (Twilio, Anthropic,
   ElevenLabs console) — this stops the attacker immediately
   without waiting for our redeploy.
3. **Rotate our env** — update the affected var.
4. **Redeploy** — both tiers if applicable.
5. **Check logs** for the first few minutes after deploy to make
   sure legitimate traffic is working.
6. **File an incident** — any leaked credential is incident-class.

## Consequences

**Benefits of current state:**

- Six of nine secrets support zero-downtime rotation via the
  provider's own multi-key support (Anthropic, ElevenLabs,
  Upstash) or dual-token patterns (Twilio, AWS IAM).
- Rotation procedure is documented per-secret.
- Emergency rotation has a written playbook.

**Known gap:**

- `OUTBOUND_API_KEY` and (less urgently) `CRON_SECRET` can only
  be rotated atomically. Planned rotation of `OUTBOUND_API_KEY`
  requires coordinated client + server redeploys. The fix
  (`OUTBOUND_API_KEYS` plural) is scoped above but not built.

## Alternatives considered

**Build `OUTBOUND_API_KEYS` plural now.** Only ~40 lines. Rejected
because there's no caller who actually needs zero-downtime
rotation today — we're a single-tenant app with one client, and
that client would coordinate a rotation with us anyway. When the
first customer pushes back on rotation downtime, build it.

**Use OAuth 2.0 or JWT with short-lived tokens.** The "correct"
answer for a multi-tenant SaaS. Rejected because the complexity
(token issuer, refresh flow, JWKS endpoint) is massive for a
single-tenant system and the current `Bearer <static-token>`
shape is perfectly adequate.

**Use a secret manager (Vault, AWS Secrets Manager).** Abstract
secret storage behind a manager so rotation is "update in the
manager." Adds a network dependency at startup and doesn't
actually solve the zero-downtime-rotation problem for our single
Bearer token. Deferred.

## See also

- `src/core/auth.ts` — where the multi-key change would land.
- `docs/RUNBOOK.md#symptom-i-need-to-rotate-a-secret` — links
  back here.
- `src/services/dynamo.ts` — AWS credential usage context.
