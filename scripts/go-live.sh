#!/usr/bin/env bash
#
# scripts/go-live.sh — guided rollout helper for the SMS/voice reminder edge.
#
# Runs the AWS- and Twilio-side go-live steps that an authenticated AWS
# CloudShell can do directly (no Vercel login required), and points you at the
# Vercel dashboard for the few steps that must happen there. Safe to re-run —
# every action is idempotent or read-only, and the SMS smoke test fails closed
# (it can return {"sid":"suppressed"} but never spams).
#
# Prereqs: run from a checkout of this repo in AWS CloudShell (or any shell with
# the AWS CLI authenticated for the target account + region). Needs: aws, curl,
# and — for the Twilio step — node/npm (already present in CloudShell).
#
# Usage:
#   ./scripts/go-live.sh                 # interactive menu
#   STAGE=prod AWS_REGION=us-east-1 ./scripts/go-live.sh
#
# Nothing here sets Vercel env vars (that needs the dashboard or an authed
# Vercel CLI) — option 5 prints exactly what to set and why.

set -uo pipefail

REGION="${AWS_REGION:-us-east-1}"
STAGE="${STAGE:-prod}"
PREFIX="/cotrackpro/${STAGE}"

c_g(){ printf '\033[32m%s\033[0m\n' "$*"; }   # green
c_r(){ printf '\033[31m%s\033[0m\n' "$*"; }   # red
c_y(){ printf '\033[33m%s\033[0m\n' "$*"; }   # yellow
c_b(){ printf '\033[1m%s\033[0m\n'  "$*"; }   # bold

ssm(){ aws ssm get-parameter --region "$REGION" --name "$1" --with-decryption \
         --query Parameter.Value --output text 2>/dev/null; }

# Cached prompts.
EDGE_HOST="${EDGE_HOST:-}"
TEST_PHONE="${TEST_PHONE:-}"

ask_host(){
  [ -n "$EDGE_HOST" ] && return 0
  read -rp "Edge host (bare, e.g. cotrackpro-talk.vercel.app): " EDGE_HOST
  case "$EDGE_HOST" in ""|*://*|*/*) c_r "  bare host only — no https:// or slashes"; EDGE_HOST=""; return 1;; esac
}
ask_phone(){
  [ -n "$TEST_PHONE" ] && return 0
  read -rp "Your test mobile (+1...): " TEST_PHONE
  case "$TEST_PHONE" in +[0-9]*) :;; *) c_r "  must be E.164, e.g. +13145551212"; TEST_PHONE=""; return 1;; esac
}

# ── 1. Outbound SMS smoke test ────────────────────────────────────────────────
smoke_sms(){
  ask_host || return 1; ask_phone || return 1
  local bearer; bearer="$(ssm "$PREFIX/talk/outbound_api_key")"
  if [ -z "$bearer" ]; then c_r "Could not read $PREFIX/talk/outbound_api_key from SSM."; return 1; fi
  c_b "POST https://$EDGE_HOST/api/sms/send  (dedupeKey makes this safe to re-run)"
  local out code body
  out="$(curl -s -w $'\n%{http_code}' -X POST "https://$EDGE_HOST/api/sms/send" \
          -H "Authorization: Bearer $bearer" -H "Content-Type: application/json" \
          -d "{\"to\":\"$TEST_PHONE\",\"body\":\"CoTrackPro test \xE2\x9C\x85\",\"dedupeKey\":\"golive-$(date +%s)\"}")"
  code="$(printf '%s' "$out" | tail -n1)"; body="$(printf '%s' "$out" | sed '$d')"
  echo "  HTTP $code  $body"
  case "$code" in
    200) c_g "  ✅ live — check your phone for the text. (Re-run with the same dedupeKey → same sid, no 2nd text.)";;
    401) c_r "  bearer mismatch → re-run ./scripts/sync-ssm-to-vercel.sh $STAGE so Vercel's TALK_OUTBOUND_API_KEY matches SSM.";;
    500) c_r "  function crashed on boot (FUNCTION_INVOCATION_FAILED) → a required env var is missing. Run option 5.";;
    503) c_r "  bearer unconfigured in prod, or messaging service SID missing.";;
    000) c_r "  couldn't reach $EDGE_HOST — wrong host or DNS.";;
    *)   c_y "  unexpected — see body above.";;
  esac
}

# ── 2. Wire Twilio webhooks ───────────────────────────────────────────────────
wire_twilio(){
  ask_host || return 1
  command -v npm >/dev/null || { c_r "npm not found (needed for configure:twilio)."; return 1; }
  [ -d node_modules ] || { c_y "Installing deps…"; npm ci >/dev/null 2>&1 || npm install >/dev/null 2>&1; }
  local acct auth phone
  acct="$(ssm "$PREFIX/twilio/account_sid")"
  auth="$(ssm "$PREFIX/twilio/auth_token")"
  phone="$(ssm "$PREFIX/twilio/phone_number")"
  if [ -z "$acct" ] || [ -z "$auth" ] || [ -z "$phone" ]; then
    c_r "Missing twilio/* params in SSM under $PREFIX."; return 1; fi
  # env.ts requires these to be present at load (the script itself doesn't use them).
  export TWILIO_ACCOUNT_SID="$acct" TWILIO_AUTH_TOKEN="$auth" TWILIO_PHONE_NUMBER="$phone"
  export SERVER_DOMAIN="$EDGE_HOST" ELEVENLABS_API_KEY=unused ANTHROPIC_API_KEY=unused
  c_b "Pointing $phone at https://$EDGE_HOST (voiceUrl, statusCallback, smsUrl)…"
  npm run configure:twilio -- "$phone" && npm run show:twilio -- "$phone"
  c_y "⚠️  If $phone is in an A2P Messaging Service, set that service's INBOUND URL to"
  c_y "    https://$EDGE_HOST/sms/incoming in the Twilio console (it overrides the number-level smsUrl)."
}

# ── 3. Verify STOP suppression persisted to DynamoDB ─────────────────────────
check_stop(){
  c_b "Scanning DynamoDB cotrackpro-kv for suppression (sms:stop:*) rows…"
  aws dynamodb scan --region "$REGION" --table-name cotrackpro-kv \
    --filter-expression 'begins_with(pk, :p)' \
    --expression-attribute-values '{":p":{"S":"sms:stop:"}}' \
    --query 'Items[].pk' --output table 2>/dev/null \
    || c_r "Scan failed — is KV_BACKEND=dynamo with table cotrackpro-kv? (Upstash users skip this.)"
  c_y "Text STOP to your number first; a row here means the inbound webhook + durable KV work."
}

# ── 4. One-shot voice call test ───────────────────────────────────────────────
voice_test(){
  ask_host || return 1; ask_phone || return 1
  local bearer; bearer="$(ssm "$PREFIX/talk/outbound_api_key")"
  c_b "POST https://$EDGE_HOST/api/call/outbound (plays Doug's voice once)…"
  local out code
  out="$(curl -s -w $'\n%{http_code}' -X POST "https://$EDGE_HOST/api/call/outbound" \
          -H "Authorization: Bearer $bearer" -H "Content-Type: application/json" \
          -d "{\"to\":\"$TEST_PHONE\",\"voiceId\":\"doug-voice\",\"line\":\"This is a CoTrackPro test call.\",\"dedupeKey\":\"golive-call-$(date +%s)\"}")"
  code="$(printf '%s' "$out" | tail -n1)"
  echo "  HTTP $code  $(printf '%s' "$out" | sed '$d')"
  case "$code" in
    200) c_g "  ✅ call placed — your phone should ring and play the line in Doug's voice.";;
    403) c_r "  voice_consent_required → REQUIRE_VOICE_CONSENT is set true in Vercel; remove it (hub owns consent).";;
    500) c_r "  500 → likely ELEVENLABS_VOICE_ID_DOUG unset, or a missing required env var (option 5).";;
    *)   c_y "  see status/body above.";;
  esac
}

# ── 5. Vercel env checklist (must be set in the dashboard) ────────────────────
vercel_env(){
  c_b "Set these in Vercel → cotrackpro-talk → Settings → Environment Variables → Production, then redeploy:"
  cat <<'TXT'

  REQUIRED (env.ts throws on boot without them → FUNCTION_INVOCATION_FAILED):
    ANTHROPIC_API_KEY        (the SMS path doesn't call it, but the loader requires it)
    API_DOMAIN  or  SERVER_DOMAIN   = your edge host (e.g. cotrackpro-talk.vercel.app)

  KV (pick ONE — required for durable STOP + idempotency):
    DynamoDB:  KV_BACKEND=dynamo, KV_DYNAMO_TABLE=cotrackpro-kv, AWS_REGION=us-east-1,
               AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (least-priv on the table)
    Upstash :  KV_URL, KV_TOKEN   (KV_BACKEND defaults to auto)

  HUB + behavior:
    HUB_BASE_URL = the hub base URL (no trailing slash)
    REQUIRE_VOICE_CONSENT  → leave UNSET/false (hub enforces voice consent)

  MIRRORED FROM SSM by ./scripts/sync-ssm-to-vercel.sh (do NOT set by hand):
    TALK_OUTBOUND_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
    TWILIO_MESSAGING_SERVICE_SID, TWILIO_PHONE_NUMBER,
    ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID_DOUG

  After changing env vars, REDEPLOY (Deployments → ⋯ → Redeploy) — Vercel only
  applies env to new deployments.
TXT
}

menu(){
  echo
  c_b "CoTrackPro talk-edge go-live — stage=$STAGE region=$REGION"
  echo "  1) Smoke test outbound SMS        4) Test one-shot voice call"
  echo "  2) Wire Twilio webhooks           5) Vercel env checklist (dashboard)"
  echo "  3) Verify STOP row in DynamoDB    q) Quit"
  read -rp "› " choice
  case "$choice" in
    1) smoke_sms;;
    2) wire_twilio;;
    3) check_stop;;
    4) voice_test;;
    5) vercel_env;;
    q|Q) return 1;;
    *) c_y "pick 1-5 or q";;
  esac
}

c_y "Tip: run option 5 first to confirm prod env is set, then 1 (SMS) → 2 (Twilio) → 3 (STOP) → 4 (voice)."
while menu; do :; done
c_g "Done. Re-run anytime — it's safe."
