#!/usr/bin/env bash
# Deploy the CoTrackPro Talk VOICE tier to Fly.io.
#
# The inbound-voice conversation pipeline (Twilio Media Stream → ElevenLabs
# STT → Claude → ElevenLabs TTS, over the WebSocket /call/stream in
# src/handlers/callHandler.ts) needs an always-on host — Vercel's serverless
# runtime can't hold a long-lived bidirectional audio WebSocket. This script
# mirrors the runtime secrets from AWS SSM into Fly secrets and runs
# `flyctl deploy`. Sibling to scripts/push-env-login.sh (Vercel side).
#
# Architecture (hybrid): Vercel keeps the HTTP edge (talk.cotrackpro.com:
# /call/incoming TwiML, /call/status, SMS, /api/*); Fly serves the audio
# WebSocket. After deploying here, set WS_DOMAIN=<this Fly host> on the
# Vercel project so /call/incoming streams audio to wss://<fly-host>/call/stream.
#
# Prereqs:
#   - flyctl installed + authenticated:  fly auth login
#   - AWS creds with SSM read on /cotrackpro/<stage>/*  (CloudShell has these)
#   - the Fly app exists (fly.toml `app` name); create with `fly apps create <app>`
#
# Usage:  bash scripts/deploy-fly.sh [prod|test]   (default: prod)
set -uo pipefail

STAGE="${1:-prod}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="/cotrackpro/${STAGE}"
APP="${FLY_APP:-cotrackpro-talk}"           # matches fly.toml `app`
FLY_HOST="${FLY_HOST:-${APP}.fly.dev}"      # public hostname Fly assigns

FLY="$(command -v flyctl || command -v fly || true)"
[ -n "$FLY" ] || { echo "ERR: flyctl not found. Install: https://fly.io/docs/flyctl/install/"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "ERR: aws CLI not found."; exit 1; }

"$FLY" auth whoami >/dev/null 2>&1 || { echo "ERR: not logged into Fly. Run:  fly auth login   then re-run."; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { echo "ERR: no AWS credentials. Use AWS CloudShell, or 'aws configure', then re-run."; exit 1; }
"$FLY" status --app "$APP" >/dev/null 2>&1 || { echo "ERR: Fly app '$APP' not found. Create it first:  fly apps create $APP"; exit 1; }

echo "Fly app: $APP   host: $FLY_HOST   secrets from SSM: $PREFIX"

ssm() { aws ssm get-parameter --region "$REGION" --name "$PREFIX/$1" --with-decryption --query Parameter.Value --output text 2>/dev/null; }

# SSM suffix -> runtime env var. The first three Twilio + ElevenLabs +
# Anthropic keys are required() in src/config/env.ts (the app won't boot
# without them); the rest are optional but make the voice flow complete.
MAP=(
  "twilio/account_sid:TWILIO_ACCOUNT_SID"
  "twilio/auth_token:TWILIO_AUTH_TOKEN"
  "twilio/phone_number:TWILIO_PHONE_NUMBER"
  "twilio/messaging_service_sid:TWILIO_MESSAGING_SERVICE_SID"
  "elevenlabs/api_key:ELEVENLABS_API_KEY"
  "elevenlabs/voice_id_doug:ELEVENLABS_VOICE_ID_DOUG"
  "anthropic/api_key:ANTHROPIC_API_KEY"
  "talk/outbound_api_key:TALK_OUTBOUND_API_KEY"
)

# Stage secrets as KEY=VALUE lines for `flyctl secrets import` (stdin keeps
# values out of the process list and shell history).
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
missing=0
for entry in "${MAP[@]}"; do
  suffix="${entry%%:*}"; name="${entry##*:}"
  val="$(ssm "$suffix")"
  if [ -z "$val" ] || [ "$val" = "None" ]; then
    echo "  WARN $name: $PREFIX/$suffix not in SSM - skipped"; missing=1; continue
  fi
  printf '%s=%s\n' "$name" "$val" >> "$TMP"
  echo "  staged $name"
done

# Non-secret runtime config (set as secrets so they're present in the
# container env). SERVER_DOMAIN lets env.ts boot in single-host mode on Fly;
# HUB_BASE_URL powers caller recognition (resolveInboundCaller); the MCP URL
# backs the in-call workflow tools.
{
  printf 'SERVER_DOMAIN=%s\n' "$FLY_HOST"
  printf 'HUB_BASE_URL=%s\n' "https://cotrackpro.com"
  printf 'COTRACKPRO_MCP_URL=%s\n' "https://mcp.cotrackpro.com/sse"
} >> "$TMP"
echo "  staged SERVER_DOMAIN=$FLY_HOST, HUB_BASE_URL, COTRACKPRO_MCP_URL"

echo "Staging Fly secrets (applied on the deploy below — single restart)..."
"$FLY" secrets import --stage --app "$APP" < "$TMP"

echo "Deploying image to Fly..."
"$FLY" deploy --app "$APP"

echo ""
echo "Done. Verify the voice host is up:"
echo "  curl -sS https://$FLY_HOST/health"
echo "Then point the Vercel edge at it (so /call/incoming streams here):"
echo "  vercel env add WS_DOMAIN production   # value: $FLY_HOST   (then redeploy Vercel)"
[ "$missing" = 0 ] || echo "NOTE: some secrets were missing in SSM (see WARN lines) — set them and re-run."
