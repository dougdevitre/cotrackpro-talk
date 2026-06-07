#!/usr/bin/env bash
# scripts/sync-ssm-to-vercel.sh
#
# Mirror CoTrackPro Voice Center config from AWS SSM Parameter Store (the
# single source of truth) into a runtime — by default the Vercel HTTP
# tier, optionally Fly.io for the WS tier. The talk app runs on Vercel
# and CANNOT read SSM at runtime, so we copy the values into Vercel env
# at deploy time. Idempotent: re-running replaces existing values.
#
# SSM is the source of truth — code reads process.env only. This script
# is the bridge. Namespace is /cotrackpro/<stage>/.
#
# USAGE:
#   ./scripts/sync-ssm-to-vercel.sh [--stage prod|staging|...] \
#                                   [--target vercel|fly] \
#                                   [--env production|preview|development] \
#                                   [--prefix /cotrackpro/<stage>] \
#                                   [--region us-east-1] \
#                                   [--fly-app <name>] \
#                                   [--dry-run]
#
# --stage sets the SSM namespace (/cotrackpro/<stage>) AND, unless --env
# is given, the Vercel environment: prod → production, anything else →
# preview. --prefix overrides the derived namespace if you need to.
#
# Examples:
#   ./scripts/sync-ssm-to-vercel.sh                      # prod → Vercel production
#   ./scripts/sync-ssm-to-vercel.sh --stage staging      # staging → Vercel preview
#   ./scripts/sync-ssm-to-vercel.sh --dry-run            # plan-only, no writes
#   ./scripts/sync-ssm-to-vercel.sh --target fly --fly-app cotrackpro-ws
#
# REQUIREMENTS:
#   - aws CLI with an IAM credential granting, on this stage's paths
#     (/cotrackpro/<stage>/talk/*, /twilio/*, /elevenlabs/*, ...):
#         ssm:GetParameter, ssm:GetParametersByPath, kms:Decrypt
#   - vercel CLI (when --target vercel). In CI, set VERCEL_TOKEN (and
#     VERCEL_ORG_ID / VERCEL_PROJECT_ID, which the CLI reads to target the
#     right project non-interactively); locally, `vercel login` + `vercel
#     link` is enough.
#   - fly CLI authenticated for the app   (when --target fly)
#
# A2P NOTE: TWILIO_MESSAGING_SERVICE_SID is the A2P-registered Messaging
# Service. Outbound SMS is sent THROUGH it (not a bare from-number) so
# every send is attributed to the approved brand/campaign — keep it in
# sync here.
#
# WHAT IT SYNCS (SSM path → env var):
#   $PREFIX/talk/outbound_api_key             → TALK_OUTBOUND_API_KEY
#   $PREFIX/twilio/account_sid                → TWILIO_ACCOUNT_SID
#   $PREFIX/twilio/auth_token                 → TWILIO_AUTH_TOKEN
#   $PREFIX/twilio/messaging_service_sid      → TWILIO_MESSAGING_SERVICE_SID
#   $PREFIX/twilio/phone_number               → TWILIO_PHONE_NUMBER
#   $PREFIX/elevenlabs/api_key                → ELEVENLABS_API_KEY
#   $PREFIX/elevenlabs/voice_id_doug          → ELEVENLABS_VOICE_ID_DOUG
#   $PREFIX/elevenlabs/tts_voice_id           → ELEVENLABS_TTS_VOICE_ID
#   $PREFIX/anthropic/api_key                 → ANTHROPIC_API_KEY
#   $PREFIX/cotrackpro/mcp_url                → COTRACKPRO_MCP_URL
#   $PREFIX/voice/inbound_phone_map           → INBOUND_PHONE_VOICE_MAP

set -euo pipefail

STAGE="prod"
TARGET="vercel"
VERCEL_ENV=""          # derived from --stage unless set explicitly
PREFIX=""              # derived from --stage unless set explicitly
REGION="us-east-1"
FLY_APP="${FLY_APP_NAME:-}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)    STAGE="$2";      shift 2 ;;
    --target)   TARGET="$2";     shift 2 ;;
    --env)      VERCEL_ENV="$2"; shift 2 ;;
    --prefix)   PREFIX="$2";     shift 2 ;;
    --region)   REGION="$2";     shift 2 ;;
    --fly-app)  FLY_APP="$2";    shift 2 ;;
    --dry-run)  DRY_RUN=1;       shift   ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Derive the SSM namespace from the stage unless overridden.
[[ -z "$PREFIX" ]] && PREFIX="/cotrackpro/$STAGE"

# Map stage → Vercel environment unless overridden. Only prod fans out to
# the production environment; every other stage targets preview so a
# staging sync can never clobber prod env.
if [[ -z "$VERCEL_ENV" ]]; then
  case "$STAGE" in
    prod|production) VERCEL_ENV="production" ;;
    *)               VERCEL_ENV="preview" ;;
  esac
fi

case "$TARGET" in
  vercel)
    : ;;
  fly)
    if [[ -z "$FLY_APP" ]]; then
      echo "Error: --target fly requires --fly-app <name> or FLY_APP_NAME" >&2
      exit 2
    fi
    ;;
  *)
    echo "Unknown --target: $TARGET (expected vercel|fly)" >&2
    exit 2
    ;;
esac

# Mapping: SSM suffix → env var name.
# Suffix is everything after $PREFIX/.
declare -A MAP=(
  # Shared hub↔talk bearer (presented to the hub, verified on hub calls).
  ["talk/outbound_api_key"]="TALK_OUTBOUND_API_KEY"
  # Twilio. Outbound SMS is sent via the A2P Messaging Service SID.
  ["twilio/account_sid"]="TWILIO_ACCOUNT_SID"
  ["twilio/auth_token"]="TWILIO_AUTH_TOKEN"
  ["twilio/messaging_service_sid"]="TWILIO_MESSAGING_SERVICE_SID"
  ["twilio/phone_number"]="TWILIO_PHONE_NUMBER"
  # ElevenLabs.
  ["elevenlabs/api_key"]="ELEVENLABS_API_KEY"
  ["elevenlabs/voice_id_doug"]="ELEVENLABS_VOICE_ID_DOUG"
  ["elevenlabs/tts_voice_id"]="ELEVENLABS_TTS_VOICE_ID"
  # Other app-required runtime config (the server fails fast without
  # these, so keep mirroring them alongside the seam values above).
  ["anthropic/api_key"]="ANTHROPIC_API_KEY"
  ["cotrackpro/mcp_url"]="COTRACKPRO_MCP_URL"
  ["voice/inbound_phone_map"]="INBOUND_PHONE_VOICE_MAP"
)

# Vercel CLI wrapper. In CI, VERCEL_TOKEN authenticates non-interactively
# (the CLI also reads VERCEL_ORG_ID / VERCEL_PROJECT_ID to target the
# project); locally it's a passthrough to a logged-in, linked CLI.
VERCEL_TOKEN="${VERCEL_TOKEN:-}"
vercel_cmd() {
  if [[ -n "$VERCEL_TOKEN" ]]; then
    vercel "$@" --token "$VERCEL_TOKEN"
  else
    vercel "$@"
  fi
}

# Push one secret to the configured target. Values are NEVER echoed —
# this script is the bridge for production secrets, so even --dry-run
# only prints byte counts.
push_secret() {
  local var_name="$1"
  local value="$2"
  local bytes="${#value}"

  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ "$TARGET" == "vercel" ]]; then
      echo "  would set  $var_name (bytes=$bytes) via vercel env add ... $VERCEL_ENV"
    else
      echo "  would set  $var_name (bytes=$bytes) via fly secrets set ... -a $FLY_APP"
    fi
    return 0
  fi

  if [[ "$TARGET" == "vercel" ]]; then
    # vercel env add is interactive by default; pipe the value in and
    # remove any pre-existing var so the add takes. `|| true` lets the
    # remove no-op when nothing was set yet.
    vercel_cmd env rm "$var_name" "$VERCEL_ENV" --yes >/dev/null 2>&1 || true
    printf '%s' "$value" | vercel_cmd env add "$var_name" "$VERCEL_ENV" >/dev/null
    echo "  set  $var_name (bytes=$bytes)"
  else
    # Buffer KEY=VALUE assignments and flush once at the end so Fly
    # only schedules a single redeploy. The buffer is process-level
    # state — see FLY_PAIRS below.
    FLY_PAIRS+=("$var_name=$value")
    echo "  queued  $var_name (bytes=$bytes)"
  fi
}

flush_fly() {
  if [[ "$TARGET" != "fly" ]]; then return 0; fi
  if [[ "${#FLY_PAIRS[@]}" -eq 0 ]]; then
    echo "  (nothing to push to Fly)"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  would run: fly secrets set <${#FLY_PAIRS[@]} pairs> -a $FLY_APP"
    return 0
  fi
  # shellcheck disable=SC2068
  fly secrets set ${FLY_PAIRS[@]} -a "$FLY_APP" >/dev/null
  echo "  pushed ${#FLY_PAIRS[@]} secret(s) to Fly app $FLY_APP (1 redeploy)"
}

FLY_PAIRS=()
echo "Syncing SSM (stage=$STAGE, prefix=$PREFIX, $REGION) → target=$TARGET${DRY_RUN:+ (dry-run)}"
[[ "$TARGET" == "vercel" ]] && echo "  vercel env: $VERCEL_ENV"
[[ "$TARGET" == "fly"    ]] && echo "  fly app:   $FLY_APP"

for suffix in "${!MAP[@]}"; do
  ssm_name="$PREFIX/$suffix"
  vercel_name="${MAP[$suffix]}"

  if ! value="$(aws ssm get-parameter --region "$REGION" \
        --name "$ssm_name" --with-decryption \
        --query 'Parameter.Value' --output text 2>/dev/null)"; then
    echo "  skip $ssm_name (not found)"
    continue
  fi

  push_secret "$vercel_name" "$value"
done

flush_fly

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry-run complete. No values written."
else
  echo "Done. Trigger a redeploy on the target if needed."
fi
