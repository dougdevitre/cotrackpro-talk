# Hub ↔ Talk seam (voice auth)

The talk edge (this repo) owns the Twilio phone number. The CoTrackPro
**hub** (`cotrackpro-antigravity`, PR #182) owns identity, OTP, token
minting, and tier logic. This document describes the talk-side half of
the seam that lets an inbound caller be recognized as a signed-in user,
and lets an unlinked caller be texted a one-time sign-in link.

## Trust model

A **single shared bearer secret** authenticates hub↔talk in **both
directions**. It lives in SSM at `/cotrackpro/<stage>/talk/outbound_api_key`,
is mirrored into Vercel as `TALK_OUTBOUND_API_KEY` by
`scripts/sync-ssm-to-vercel.sh` (legacy `OUTBOUND_API_KEY` still honored
as a fallback), and is surfaced as `env.outboundApiKey` — the same token
used by `/call/outbound` and `/records/*`.

- **Talk → Hub:** we PRESENT it (`Authorization: Bearer …`).
- **Hub → Talk:** we VERIFY it constant-time via `bearerMatches`.

Clerk is never used for these server-to-server edges. The hub base URL is
configured per stage via `HUB_BASE_URL` (no trailing slash).

## Talk → Hub (`src/services/hub.ts`)

Both calls return a discriminated result and **fail open** (network /
timeout / misconfig → `{ status: "error" }`) so the inbound voice loop is
never blocked.

| Call | Endpoint | Result variants |
|------|----------|-----------------|
| `resolvePhone(phone)` | `POST {HUB_BASE_URL}/internal/v1/resolve-phone` | `linked{subject}`, `not_linked`, `unauthorized`, `not_configured`, `invalid`, `error` |
| `sendAuthLink(phone)` | `POST {HUB_BASE_URL}/internal/v1/send-auth-link` | `sent`, `rate_limited`, `sms_unavailable`, `not_configured`, `invalid`, `unauthorized`, `error` |

The talk edge **never sees the token** — on `send-auth-link` the hub
composes the entire SMS body and sends it back through our
`/api/sms/send`.

## Hub → Talk (endpoints we implement)

### `POST /api/sms/send` — implemented (`src/core/sms.ts`)

Body `{ to, body, dedupeKey }`. Verifies the shared bearer, validates the
destination (E.164 + country allow-list via `validateDialable`),
rate-limits (KV), is **idempotent on `dedupeKey`**, and sends `body`
verbatim. Responds `2xx { sid }`. `body` is never logged (it can contain
a sign-in link); phone numbers are masked.

**A2P attribution:** the message is sent **through
`TWILIO_MESSAGING_SERVICE_SID`** (the A2P 10DLC-registered Messaging
Service), not a bare from-number, so every send is attributed to the
approved brand/campaign. Production **fails closed** (`500
sms_misconfigured`) if the service SID is unset; non-prod falls back to
`TWILIO_PHONE_NUMBER` for local testing.

### `POST /api/call/outbound` — partial / deferred

The existing `/call/outbound` already places **authenticated, idempotent,
rate-limited** outbound calls with the shared bearer, but it connects the
callee to the full interactive voice loop (body `{ to, role }`,
`Idempotency-Key` header). The hub contract's one-shot variant — body
`{ to, voiceId, line, dedupeKey }` that simply *plays `line` in ElevenLabs
`voiceId`* (e.g. a voice-consent announcement) — is a distinct TTS-render
subsystem and is **not yet implemented**. It needs explicit VOICE consent
gating before any production send.

## Inbound voice loop (`src/core/twiml.ts` → `callHandler`)

On an inbound call the webhook calls `resolveInboundCaller(from)`:

1. `resolve-phone` → **linked**: pass `subject` as a `<Stream>` TwiML
   `<Parameter>`; the call handler stores it on the session for artifact
   attribution + per-call tier reads.
2. `resolve-phone` → **not_linked**: call `send-auth-link`; on `sent`,
   pass an `authNotice` parameter so the assistant speaks *"I just texted
   you a sign-in link — tap it, sign in, then call me back…"* after the
   greeting.
3. Any other outcome → proceed **anonymous**. Unlinked / unrecognized
   callers still get crisis resources + anonymous help (never gated).

After signing in via the link (`/voice-signin`, app repo), the phone is
bound and the next `resolve-phone` returns `{ subject }`.

## Configuration

The **shared registry secrets** (owned in the hub repo
`docs/ops/ssm-parameters.md`) are mirrored from AWS SSM — the single
source of truth — into Vercel env at deploy time by
`scripts/sync-ssm-to-vercel.sh` (CI: `.github/workflows/vercel-env-sync.yml`).
That script handles exactly the first seven rows below; the remaining
rows are per-environment app config set by other means. Never set the
registry secrets in the Vercel dashboard by hand.

| Vercel env | SSM source (`/cotrackpro/<stage>/…`) | Mirrored by script? | Purpose |
|-----|-----|-----|---------|
| `TALK_OUTBOUND_API_KEY` | `talk/outbound_api_key` | yes | Shared hub↔talk bearer (legacy `OUTBOUND_API_KEY` fallback) |
| `TWILIO_MESSAGING_SERVICE_SID` | `twilio/messaging_service_sid` | yes | A2P Messaging Service SMS is sent through (required in prod) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | `twilio/*` | yes | Twilio REST + from-number |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID_DOUG` | `elevenlabs/*` | yes | TTS/STT key + named "Doug" voice |
| `HUB_BASE_URL` | (per stage env) | no | Hub Function URL / custom domain (no trailing slash). Empty = hub disabled (all callers anonymous) |
| `HUB_TIMEOUT_MS` | — | no | Per-call timeout (default 4000) |
| `SMS_RATE_LIMIT_PER_MIN` / `SMS_RATE_LIMIT_PER_HOUR` | — | no | Limits on `/api/sms/send` (default 30 / 500) |

## Compliance gating (before any PRODUCTION send)

- A2P 10DLC brand + campaign on the number — see `docs/twilio-a2p-setup.md`
  (setup + campaign-rejection remediation). Trial/verified number for testing.
- STOP/HELP/START handling, suppression list, quiet hours, frequency caps.
- Separate explicit VOICE consent before outbound calls.

Full hub-side contract: `docs/plans/f7-talk-side-handoff.md` and
`docs/plans/voice-auth-fallback.md` in the hub repo.
