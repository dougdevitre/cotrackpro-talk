#!/usr/bin/env bash
# scripts/sync-ssm-to-vercel.sh
#
# Pull every CoTrackPro Voice Center parameter from AWS SSM Parameter
# Store (the canonical source) and push the values to Vercel env vars
# (the runtime). Idempotent: re-running replaces existing values.
#
# SSM is the source of truth — code reads process.env only. This
# script is the bridge.
#
# USAGE:
#   ./scripts/sync-ssm-to-vercel.sh [--env prod|preview|development] \
#                                   [--prefix /cotrackpro/prod] \
#                                   [--region us-east-1]
#
# Examples:
#   ./scripts/sync-ssm-to-vercel.sh                              # prod → prod
#   ./scripts/sync-ssm-to-vercel.sh --env preview --prefix /cotrackpro/staging
#
# REQUIREMENTS:
#   - aws CLI configured with read access to SSM
#   - vercel CLI logged in and linked to the right project (vercel link)
#
# WHAT IT SYNCS (SSM path → Vercel env var):
#   $PREFIX/voice/inbound_phone_map      → INBOUND_PHONE_VOICE_MAP
#   $PREFIX/elevenlabs/tts_voice_id      → ELEVENLABS_TTS_VOICE_ID
#   $PREFIX/twilio/account_sid           → TWILIO_ACCOUNT_SID
#   $PREFIX/twilio/auth_token            → TWILIO_AUTH_TOKEN
#   $PREFIX/twilio/phone_number          → TWILIO_PHONE_NUMBER
#   $PREFIX/elevenlabs/api_key           → ELEVENLABS_API_KEY
#   $PREFIX/anthropic/api_key            → ANTHROPIC_API_KEY
#   $PREFIX/cotrackpro/mcp_url           → COTRACKPRO_MCP_URL

set -euo pipefail

VERCEL_ENV="production"
PREFIX="/cotrackpro/prod"
REGION="us-east-1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)    VERCEL_ENV="$2"; shift 2 ;;
    --prefix) PREFIX="$2";     shift 2 ;;
    --region) REGION="$2";     shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Mapping: SSM suffix → Vercel env var name.
# Suffix is everything after $PREFIX/.
declare -A MAP=(
  ["voice/inbound_phone_map"]="INBOUND_PHONE_VOICE_MAP"
  ["elevenlabs/tts_voice_id"]="ELEVENLABS_TTS_VOICE_ID"
  ["twilio/account_sid"]="TWILIO_ACCOUNT_SID"
  ["twilio/auth_token"]="TWILIO_AUTH_TOKEN"
  ["twilio/phone_number"]="TWILIO_PHONE_NUMBER"
  ["elevenlabs/api_key"]="ELEVENLABS_API_KEY"
  ["anthropic/api_key"]="ANTHROPIC_API_KEY"
  ["cotrackpro/mcp_url"]="COTRACKPRO_MCP_URL"
)

echo "Syncing SSM ($PREFIX, $REGION) → Vercel env $VERCEL_ENV"

for suffix in "${!MAP[@]}"; do
  ssm_name="$PREFIX/$suffix"
  vercel_name="${MAP[$suffix]}"

  if ! value="$(aws ssm get-parameter --region "$REGION" \
        --name "$ssm_name" --with-decryption \
        --query 'Parameter.Value' --output text 2>/dev/null)"; then
    echo "  skip $ssm_name (not found)"
    continue
  fi

  # vercel env add is interactive by default; pipe the value in and
  # remove any pre-existing var so the add takes. `|| true` lets the
  # remove no-op when nothing was set yet.
  vercel env rm "$vercel_name" "$VERCEL_ENV" --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$vercel_name" "$VERCEL_ENV" >/dev/null
  echo "  set  $vercel_name (from $ssm_name)"
done

echo "Done. Trigger a redeploy for the new values to take effect."
