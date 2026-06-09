# Go-Live: SMS + voice reminders (hub → talk edge endpoints)

Operator checklist for taking the reminder edge endpoints to production:

- `POST /api/sms/send` — hub-composed outbound SMS
- `POST /api/call/outbound` — one-shot outbound voice in Doug's voice
- `GET  /call/voice-line` — Twilio fetches the rendered Doug audio
- `POST /sms/incoming` — Twilio inbound webhook (STOP/START/HELP + forward)

The code is implemented and unit-tested with Twilio + ElevenLabs mocked;
this doc is the deploy-time runbook for the **config, wiring, compliance,
and one live smoke test** that the mocks can't cover. The seam itself is
documented in [`docs/hub-talk-seam.md`](./hub-talk-seam.md).

> **Two hard blockers first:** (1) shared KV is mandatory — see Step 2;
> (2) the hub contract field names must match — see Step 8. Everything
> else is config + compliance.

## Prerequisites

- AWS CLI configured for `us-east-1` with `ssm:PutParameter` /
  `ssm:GetParameter` on `/cotrackpro/prod/*`.
- `vercel` CLI logged in and linked (`vercel link`).
- An Upstash Redis (or Vercel KV) database for the stage.
- A Twilio Messaging Service with an **approved A2P 10DLC brand +
  campaign** and the sending number attached.
- Doug's ElevenLabs voice cloned, with its `voice_id` known.
- Local `.env` has `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `API_DOMAIN`
  so `npm run configure:twilio` can reach the Twilio API.

## Step 1 — Populate SSM (registry secrets)

SSM is the source of truth; `scripts/sync-ssm-to-vercel.sh` mirrors the
seven registry params into Vercel. **Never edit Vercel env directly.**
The two that this feature specifically depends on:

```bash
REGION=us-east-1
PREFIX=/cotrackpro/prod

# A2P Messaging Service SID — outbound SMS is sent THROUGH this so every
# message is brand/campaign-attributed. Prod fails closed without it.
aws ssm put-parameter --region $REGION --type String --overwrite \
  --name $PREFIX/twilio/messaging_service_sid --value 'MGxxxxxxxx'

# Doug's cloned voice. Required — resolveVoiceId("doug-voice") returns a
# 500 voice_unconfigured until this is set.
aws ssm put-parameter --region $REGION --type String --overwrite \
  --name $PREFIX/elevenlabs/voice_id_doug --value 'XXXXXXXXXXXXXXXXXXXX'
```

The shared bearer (`talk/outbound_api_key`), `twilio/account_sid`,
`twilio/auth_token`, `twilio/phone_number`, and `elevenlabs/api_key` are
pre-existing — re-put only when rotating.

## Step 2 — Shared KV (MANDATORY) ⚠️

The suppression list (STOP) and idempotency (`dedupeKey`) live in the KV
store (`src/services/kv.ts`). The default backend is **in-memory and
per-process** — on Vercel serverless that means **an opt-out written on
one request is invisible to the next**, and `dedupeKey` won't dedupe a
retry. You MUST point KV at Upstash/Vercel KV:

```bash
vercel env add KV_URL   production   # https://<db>.upstash.io
vercel env add KV_TOKEN production   # Upstash REST token
# KV_BACKEND defaults to "auto" → uses upstash when URL+TOKEN are set.
```

Do **not** go live on the memory backend. STOP compliance and the
no-double-send guarantee both depend on this.

## Step 3 — App config (non-secret env)

Set on Vercel (or via your env pipeline) for the stage:

| Var | Recommended | Purpose |
|-----|-------------|---------|
| `HUB_BASE_URL` | prod hub URL (no trailing slash) | talk → hub calls |
| `REQUIRE_VOICE_CONSENT` | `true` | gate robocalls on hub-attested consent (Step 8) |
| `CALL_DAILY_CAP` | `50` (tune) | hard per-day outbound-voice cap |
| `VOICE_LINE_TTL_SECONDS` | `3600` | pending-render pointer TTL |
| `SMS_RATE_LIMIT_PER_MIN` / `_PER_HOUR` | `30` / `500` | SMS send caps |
| `OUTBOUND_RATE_LIMIT_PER_MIN` / `_PER_HOUR` | `30` / `500` | voice per-min/hour caps |

`VALIDATE_TWILIO_SIGNATURE` is **forced on in production** regardless of
the env var — no action needed, but it means a wrong `API_DOMAIN` or a
broken `vercel.json` rewrite will 403 every webhook (see Step 9).

## Step 4 — Preflight

```bash
npm run preflight   # typecheck + unit tests + config lint
```

Do not sync or deploy on a red preflight.

## Step 5 — Sync + deploy

```bash
./scripts/sync-ssm-to-vercel.sh prod    # mirror the 7 registry secrets
vercel deploy --prod

# Verify the feature's secrets landed (values never printed):
vercel env ls production | grep -E 'MESSAGING_SERVICE_SID|VOICE_ID_DOUG|KV_URL'
```

## Step 6 — A2P 10DLC + opt-out compliance

- Confirm the Messaging Service's **brand + campaign are APPROVED** and
  the sending number is attached. Unregistered A2P traffic is filtered.
- **Advanced Opt-Out alignment.** If the Messaging Service has carrier
  Advanced Opt-Out enabled, Twilio intercepts STOP itself and our
  `/sms/incoming` may not see it. Decide who owns suppression:
  - Let our app own it → **disable** Advanced Opt-Out on the service so
    STOP reaches `/sms/incoming` (it writes the suppression list + calls
    `record-consent`).
  - Let Twilio own it → keep it on, and know our app-level suppression
    list will only catch STOPs that bypass the carrier layer.
  Running both un-aligned risks a number Twilio considers opted-out but
  our list considers active (or vice-versa).
- Quiet hours / frequency caps: confirm these are enforced hub-side
  (talk enforces only the per-min/hour/day rate caps, not time-of-day).

## Step 7 — Point Twilio at the app

```bash
npm run configure:twilio -- +1XXXXXXXXXX
npm run show:twilio     -- +1XXXXXXXXXX
```

This sets the number's `voiceUrl → /call/incoming`,
`statusCallback → /call/status`, and `smsUrl → /sms/incoming` (POST).

**Messaging Service caveat:** for compliant A2P sending the number is in
a Messaging Service, and the **service's inbound URL overrides the
number-level `smsUrl`**. In that topology, set the Messaging Service
*Integration → inbound request URL* to `https://$API_DOMAIN/sms/incoming`
in the console (the script prints a warning when the number is attached
to a service).

## Step 8 — Verify the hub contract

The talk → hub calls were built to these shapes; confirm the hub matches
before enabling traffic (`src/services/hub.ts`):

- `POST /internal/v1/record-consent` ← `{ phone, state:"opted_in"|"opted_out", channel:"sms", keyword }`
- `POST /internal/v1/inbound-sms` ← `{ from, to, body, messageSid }` → `{ reply? }`
- The hub **always sends `dedupeKey`** on `/api/sms/send` and
  `/api/call/outbound` (both now 400 without it).
- The hub **sends `consent: true`** on `/api/call/outbound` once it has
  captured voice consent. With `REQUIRE_VOICE_CONSENT=true`, voice calls
  403 (`voice_consent_required`) until it does — fail-closed by design.

## Step 9 — Live smoke test

On a registered test number + your own phone:

1. **SMS send** — trigger a hub send → `/api/sms/send`; confirm delivery
   and that the body is verbatim (no doubled footer).
2. **STOP** → confirm no more sends arrive and a repeat send returns
   `{ sid: "suppressed" }`; **START** → re-enabled; **HELP** → static
   reply; a non-keyword → forwarded, hub reply returns with one footer.
3. **Inbound signature** — confirm `/sms/incoming` accepts a real signed
   Twilio request (a 403 here means `API_DOMAIN`/rewrite mismatch, not a
   bug in the keyword logic).
4. **Outbound voice** — place a call with `consent:true`; confirm **Doug
   audio actually plays**. This is the only path with zero mocked-test
   coverage: it exercises the ElevenLabs render + `/call/voice-line`
   fetch + the audio cache end-to-end.
5. Confirm `https://$API_DOMAIN/call/voice-line?id=…` returns
   `audio/mpeg` (Twilio fetches it unauthenticated; the signed token is
   the only protection).

## Observability

Alert on: SMS/call send failures, 429s (rate/daily-cap hits),
`voice_unconfigured` / `render_failed` (ElevenLabs), `voice_consent_required`
spikes (hub not attesting), and hub 5xx. All log lines mask the phone and
never log the body/line — correlate on `messageSid` / `dedupeHash` /
`callSid`.

## Rollback

- **Disable voice** without a deploy: `REQUIRE_VOICE_CONSENT=true` plus a
  hub that stops sending `consent:true` → every voice call 403s (no
  calls placed). Or set `CALL_DAILY_CAP=0` to hard-stop voice via the
  rate limiter.
- **Disable SMS send/inbound**: point the Twilio webhook away or unset
  the Messaging Service SID (prod then fails closed on send).
- The endpoints are additive — reverting this branch removes them
  without touching the inbound-voice path.

## Quick reference

| Command | What it does |
|---------|--------------|
| `npm run preflight` | typecheck + tests + config lint |
| `npm run configure:twilio -- +<E164>` | set voice + SMS webhooks on a number |
| `npm run show:twilio -- +<E164>` | read back current Twilio config |
| `./scripts/sync-ssm-to-vercel.sh prod` | mirror the 7 registry secrets → Vercel prod |
| `vercel env ls production` | confirm KV + feature secrets landed |
