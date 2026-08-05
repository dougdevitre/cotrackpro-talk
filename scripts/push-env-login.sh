#!/usr/bin/env bash
# Push the talk app's SSM secrets into Vercel production using a LOGGED-IN
# `vercel` CLI session — no VERCEL_TOKEN needed. Run `vercel login` once
# (browser device flow), then run this. Then it redeploys production.
#
# Why this exists: the token-based sync (scripts/sync-ssm-to-vercel.sh, used
# by CI) keeps tripping on bad/placeholder tokens when run by hand. `vercel
# login` removes the token entirely — there's no string to paste or quote.
#
# Requirements:
#   - vercel CLI installed and logged in (`vercel login`)
#   - AWS credentials with SSM read on /cotrackpro/<stage>/* (CloudShell has
#     these automatically; on a laptop run `aws configure` / SSO first)
#
# Usage:  bash scripts/push-env-login.sh [prod|test]   (default: prod)
set -uo pipefail

STAGE="${1:-prod}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="/cotrackpro/${STAGE}"
TARGET="production"; [ "$STAGE" = "test" ] && TARGET="preview"
export VERCEL_ORG_ID="${VERCEL_ORG_ID:-team_DJXivUKK5Uf3elW5FQB3ZDJu}"
export VERCEL_PROJECT_ID="${VERCEL_PROJECT_ID:-prj_ZHLtOAV6jtu1wV1jEmuyz2dPZUe2}"

command -v vercel >/dev/null 2>&1 || { echo "ERR: vercel CLI not found. Install:  npm i -g vercel"; exit 1; }
command -v aws    >/dev/null 2>&1 || { echo "ERR: aws CLI not found."; exit 1; }
vercel whoami >/dev/null 2>&1 || { echo "ERR: not logged into Vercel. Run:  vercel login   then re-run this."; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { echo "ERR: no AWS credentials. Use AWS CloudShell, or run 'aws configure' / SSO, then re-run."; exit 1; }
echo "vercel: $(vercel whoami 2>/dev/null)   aws acct: $(aws sts get-caller-identity --query Account --output text 2>/dev/null)"
echo "Syncing SSM $PREFIX  ->  Vercel env '$TARGET'"

# SSM suffix  ->  Vercel env var name (must match src/config/env.ts).
#
# Keep this list in lockstep with scripts/sync-ssm-to-vercel.sh — the two
# scripts do the same job by different auth routes, and a var present in one
# but not the other means the Vercel env depends on which one you happened
# to run.
#
# A suffix may list ALTERNATES separated by "|"; the first that resolves
# wins. Used for the Anthropic key, which lives at ai/anthropic/api_key
# (what fly-deploy.yml reads) on some accounts and anthropic/api_key on
# others. Run ./scripts/ssm-params.sh to see which one yours has.
MAP=(
  "talk/outbound_api_key:TALK_OUTBOUND_API_KEY"
  "twilio/account_sid:TWILIO_ACCOUNT_SID"
  "twilio/auth_token:TWILIO_AUTH_TOKEN"
  "twilio/messaging_service_sid:TWILIO_MESSAGING_SERVICE_SID"
  "twilio/phone_number:TWILIO_PHONE_NUMBER"
  "elevenlabs/api_key:ELEVENLABS_API_KEY"
  "elevenlabs/voice_id_doug:ELEVENLABS_VOICE_ID_DOUG"
  "ai/anthropic/api_key|anthropic/api_key:ANTHROPIC_API_KEY"
)

# Best-effort tier: mirrored if present, skipped without marking the run
# failed. WS_DOMAIN and INBOUND_PHONE_VOICE_MAP are consumed by
# api/call/incoming.ts, which runs on Vercel — without them the call
# streams to a host that can't serve it, and the per-number voice override
# never applies. KV_URL/KV_TOKEN back SMS thread memory.
OPTIONAL_MAP=(
  "talk/ws_domain:WS_DOMAIN"
  "voice/inbound_phone_map:INBOUND_PHONE_VOICE_MAP"
  "kv/url:KV_URL"
  "kv/token:KV_TOKEN"
)

# Resolve the first existing path among "|"-separated alternates; echo the
# value, or nothing if none resolve.
ssm_first() {
  local suffixes="$1" cand val
  local IFS='|'
  for cand in $suffixes; do
    val="$(aws ssm get-parameter --region "$REGION" --name "$PREFIX/$cand" --with-decryption --query Parameter.Value --output text 2>/dev/null)"
    if [ -n "$val" ] && [ "$val" != "None" ]; then printf '%s' "$val"; return 0; fi
  done
  return 1
}

push_var() {  # push_var <env-name> <value>
  vercel env rm "$1" "$TARGET" --yes >/dev/null 2>&1 || true
  printf '%s' "$2" | vercel env add "$1" "$TARGET" >/dev/null 2>&1
}

fail=0
for entry in "${MAP[@]}"; do
  suffix="${entry%%:*}"; name="${entry##*:}"
  if ! val="$(ssm_first "$suffix")"; then
    echo "  WARN $name: $PREFIX/${suffix%%|*} not in SSM - skipped"; fail=1; continue
  fi
  if push_var "$name" "$val"; then
    echo "  set $name ok"
  else
    echo "  ERR  failed to set $name"; fail=1
  fi
done

for entry in "${OPTIONAL_MAP[@]}"; do
  suffix="${entry%%:*}"; name="${entry##*:}"
  if ! val="$(ssm_first "$suffix")"; then
    echo "  skip $name (optional; $PREFIX/${suffix%%|*} not set)"; continue
  fi
  if push_var "$name" "$val"; then
    echo "  set $name ok (optional)"
  else
    echo "  ERR  failed to set $name"; fail=1
  fi
done

# Redeploy so the new env is picked up. Deploy the repo (cwd), falling back
# to the conventional checkout location.
[ -f package.json ] || cd "$HOME/cotrackpro-talk" 2>/dev/null || true
echo "Redeploying $TARGET ..."
if [ "$TARGET" = "production" ]; then vercel deploy --prod; else vercel deploy; fi

echo "Done."
[ "$fail" = 0 ] || echo "NOTE: some vars were skipped/failed - see WARN/ERR lines above."
