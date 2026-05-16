# Go-Live: Inbound voice override (per-phone `INBOUND_PHONE_VOICE_MAP`)

Operator checklist for pointing a Twilio number at this app with a
specific ElevenLabs voice + CoTrackPro role. Use this when standing
up a new number, rotating a voice, or troubleshooting why a call
landed on the wrong persona.

The code path itself is in
[`docs/adr/`](./adr/) and the README "Per-phone voice overrides"
section; this doc is the deploy-time runbook only.

## Prerequisites

- AWS CLI configured for `us-east-1` with `ssm:PutParameter` +
  `ssm:GetParameter` on `/cotrackpro/prod/*`.
- `vercel` CLI logged in and linked to the project (`vercel link`).
- `fly` CLI authenticated for the WS host app
  (`fly auth login`; app name in `$FLY_APP_NAME` or `--fly-app`).
- Local `.env` has `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
  `API_DOMAIN` set so `npm run configure:twilio` can reach the
  Twilio API.

## Step 1 — Populate SSM (canonical source)

SSM Parameter Store is the source of truth. **Never edit Vercel or
Fly env vars directly** — they get overwritten on the next sync.

```bash
REGION=us-east-1
PREFIX=/cotrackpro/prod

# The per-phone voice/role map. Add or remove entries here.
aws ssm put-parameter --region $REGION --type String --overwrite \
  --name $PREFIX/voice/inbound_phone_map \
  --value '{"+13143948500":{"voiceId":"2ydcbtd5sJZRYFMNgMVZ","role":"parent"}}' \
  --description "Per-phone voice/role override consumed by /call/incoming"

# Browser TTS default (parity with the code default).
aws ssm put-parameter --region $REGION --type String --overwrite \
  --name $PREFIX/elevenlabs/tts_voice_id \
  --value '2ydcbtd5sJZRYFMNgMVZ'

# The rest are pre-existing secrets — only re-put when rotating.
aws ssm put-parameter --region $REGION --type SecureString --overwrite \
  --name $PREFIX/twilio/account_sid  --value 'ACxxxx'
aws ssm put-parameter --region $REGION --type SecureString --overwrite \
  --name $PREFIX/twilio/auth_token   --value 'xxxx'
aws ssm put-parameter --region $REGION --type String        --overwrite \
  --name $PREFIX/twilio/phone_number --value '+13143948500'
aws ssm put-parameter --region $REGION --type SecureString --overwrite \
  --name $PREFIX/elevenlabs/api_key  --value 'xxxx'
aws ssm put-parameter --region $REGION --type SecureString --overwrite \
  --name $PREFIX/anthropic/api_key   --value 'xxxx'
aws ssm put-parameter --region $REGION --type String        --overwrite \
  --name $PREFIX/cotrackpro/mcp_url  --value 'https://mcp.cotrackpro.com/sse'

# Sanity check.
aws ssm get-parameters-by-path --region $REGION --path $PREFIX --recursive \
  --with-decryption --query 'Parameters[].Name'
```

## Step 2 — Preflight

Run the bundled gate locally before kicking off any sync or deploy.
It runs typecheck + unit tests + the strict
`INBOUND_PHONE_VOICE_MAP` validator. Exits non‑zero on any failure.

```bash
# Pull the canonical map locally so the lint step actually validates it.
export INBOUND_PHONE_VOICE_MAP=$(aws ssm get-parameter --region us-east-1 \
  --name /cotrackpro/prod/voice/inbound_phone_map \
  --query 'Parameter.Value' --output text)

npm run preflight
```

If `lint:config` reports errors (bad voiceId format, unknown role,
or a key collision after E.164 normalization) — fix the map in SSM
and re-run. **Do not sync.**

## Step 3 — Sync SSM → runtimes

Bridge from SSM into the runtime env vars. Always start with
`--dry-run`; the script prints byte counts only and never echoes
secret values.

```bash
# Vercel HTTP tier
./scripts/sync-ssm-to-vercel.sh --dry-run
./scripts/sync-ssm-to-vercel.sh --env production

# Fly WS tier (single redeploy via batched fly secrets set)
FLY_APP_NAME=cotrackpro-ws ./scripts/sync-ssm-to-vercel.sh --target fly --dry-run
FLY_APP_NAME=cotrackpro-ws ./scripts/sync-ssm-to-vercel.sh --target fly
```

## Step 4 — Redeploy

```bash
vercel deploy --prod
fly deploy   -a cotrackpro-ws
```

Verify the values landed:

```bash
vercel env ls production | grep INBOUND_PHONE_VOICE_MAP
fly secrets list -a cotrackpro-ws | grep INBOUND_PHONE_VOICE_MAP
```

## Step 5 — Regenerate prerecorded audio (when adding a new voice)

The greeting cache is keyed on `(role, voiceId)`. A brand-new voice
in the map will fall through to live TTS until you regenerate.
Optional, but recommended: it saves ~200ms TTFB on every call's
greeting and removes per-call TTS spend on the fixed phrases.

```bash
# Same env export as Step 2.
export INBOUND_PHONE_VOICE_MAP=$(aws ssm get-parameter --region us-east-1 \
  --name /cotrackpro/prod/voice/inbound_phone_map \
  --query 'Parameter.Value' --output text)

npm run generate-audio
git commit -am "regen prerecorded audio for new override voice"
git push
```

The generator walks `DEFAULT_VOICE_MAP` + `INBOUND_PHONE_VOICE_MAP`
and emits `${role}__${voiceId}`-keyed entries into
`src/audio/prerecorded.ts`. Skip this step when rotating an existing
voice id only — the existing cache stays valid until you change a
phrase.

## Step 6 — Point Twilio at the app

```bash
npm run configure:twilio -- +13143948500
npm run show:twilio     -- +13143948500
```

Confirm `voiceUrl` resolves to `https://$API_DOMAIN/call/incoming`
and `statusCallback` to `https://$API_DOMAIN/call/status`.

## Step 7 — Live dial test

Dial the number from a real phone. Expect:

1. Audio plays in the override voice (audibly different from the
   prior default `EXAVITQu4vr4xnSDxMaL` for the `parent` role).
2. A log entry on the API tier:
   ```
   {msg: "Inbound phone map match", callSid: "CA…",
    to: "+13143948500", role: "parent",
    voiceId: "2ydcbtd5sJZRYFMNgMVZ"}
   ```
3. Ask a CoTrackPro-style question. Expect a `tool_use` log entry
   from `src/handlers/callHandler.ts:495` hitting
   `env.cotrackproMcpUrl`.

## Adding more numbers

1. Edit the JSON in SSM (Step 1, just the
   `voice/inbound_phone_map` parameter).
2. Re-run **Steps 2–4** (preflight + sync + redeploy).
3. Re-run **Step 5** only if the new entry introduces a new voice id
   that isn't already in the cache.

## Rollback

Revert the SSM map (either an empty JSON object or the previous
value), then sync + redeploy. The override is purely additive — an
empty map drops you back to today's `?role=` + role-default-voice
behavior. No code rollback needed.

```bash
aws ssm put-parameter --region us-east-1 --type String --overwrite \
  --name /cotrackpro/prod/voice/inbound_phone_map --value '{}'

./scripts/sync-ssm-to-vercel.sh --env production
FLY_APP_NAME=cotrackpro-ws ./scripts/sync-ssm-to-vercel.sh --target fly
vercel deploy --prod && fly deploy -a cotrackpro-ws
```

## Quick reference: operator commands

| Command                                   | What it does                                        |
|-------------------------------------------|-----------------------------------------------------|
| `npm run preflight`                       | typecheck + tests + strict map lint                 |
| `npm run lint:config`                     | strict `INBOUND_PHONE_VOICE_MAP` validator alone    |
| `npm run list:phones`                     | print the active phone map (table)                  |
| `npm run list:phones -- --json`           | print the active phone map (JSON)                   |
| `npm run configure:twilio -- +<E164>`     | set Twilio voice webhook on a number                |
| `npm run show:twilio -- +<E164>`          | read back current Twilio config for a number        |
| `npm run generate-audio`                  | regenerate the prerecorded greeting/hold/error cache|
| `./scripts/sync-ssm-to-vercel.sh --dry-run` | preview the SSM → Vercel sync                     |
| `./scripts/sync-ssm-to-vercel.sh --target fly --dry-run` | preview the SSM → Fly sync           |
