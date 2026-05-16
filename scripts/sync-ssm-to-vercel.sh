#!/usr/bin/env bash
# scripts/sync-ssm-to-vercel.sh
#
# Pull every CoTrackPro Voice Center parameter from AWS SSM Parameter
# Store (the canonical source) and push the values to a runtime — by
# default the Vercel HTTP tier, optionally Fly.io for the WS tier.
# Idempotent: re-running replaces existing values.
#
# SSM is the source of truth — code reads process.env only. This
# script is the bridge.
#
# USAGE:
#   ./scripts/sync-ssm-to-vercel.sh [--target vercel|fly] \
#                                   [--env prod|preview|development] \
#                                   [--prefix /cotrackpro/prod] \
#                                   [--region us-east-1] \
#                                   [--fly-app <name>] \
#                                   [--dry-run]
#
# Examples:
#   ./scripts/sync-ssm-to-vercel.sh                      # prod → Vercel prod
#   ./scripts/sync-ssm-to-vercel.sh --target fly --fly-app cotrackpro-ws
#   ./scripts/sync-ssm-to-vercel.sh --dry-run            # plan-only, no writes
#
# REQUIREMENTS:
#   - aws CLI configured with read access to SSM
#   - vercel CLI logged in and linked     (when --target vercel)
#   - fly CLI authenticated for the app   (when --target fly)
#
# WHAT IT SYNCS (SSM path → env var):
#   $PREFIX/voice/inbound_phone_map      → INBOUND_PHONE_VOICE_MAP
#   $PREFIX/elevenlabs/tts_voice_id      → ELEVENLABS_TTS_VOICE_ID
#   $PREFIX/twilio/account_sid           → TWILIO_ACCOUNT_SID
#   $PREFIX/twilio/auth_token            → TWILIO_AUTH_TOKEN
#   $PREFIX/twilio/phone_number          → TWILIO_PHONE_NUMBER
#   $PREFIX/elevenlabs/api_key           → ELEVENLABS_API_KEY
#   $PREFIX/anthropic/api_key            → ANTHROPIC_API_KEY
#   $PREFIX/cotrackpro/mcp_url           → COTRACKPRO_MCP_URL

set -euo pipefail

TARGET="vercel"
VERCEL_ENV="production"
PREFIX="/cotrackpro/prod"
REGION="us-east-1"
FLY_APP="${FLY_APP_NAME:-}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
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
  ["voice/inbound_phone_map"]="INBOUND_PHONE_VOICE_MAP"
  ["elevenlabs/tts_voice_id"]="ELEVENLABS_TTS_VOICE_ID"
  ["twilio/account_sid"]="TWILIO_ACCOUNT_SID"
  ["twilio/auth_token"]="TWILIO_AUTH_TOKEN"
  ["twilio/phone_number"]="TWILIO_PHONE_NUMBER"
  ["elevenlabs/api_key"]="ELEVENLABS_API_KEY"
  ["anthropic/api_key"]="ANTHROPIC_API_KEY"
  ["cotrackpro/mcp_url"]="COTRACKPRO_MCP_URL"
)

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
    vercel env rm "$var_name" "$VERCEL_ENV" --yes >/dev/null 2>&1 || true
    printf '%s' "$value" | vercel env add "$var_name" "$VERCEL_ENV" >/dev/null
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
echo "Syncing SSM ($PREFIX, $REGION) → target=$TARGET${DRY_RUN:+ (dry-run)}"
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
