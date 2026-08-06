#!/usr/bin/env bash
#
# scripts/kv-setup.sh — provision the durable KV backend, end to end.
#
# Durable KV is mandatory: STOP suppression, dedupeKey idempotency,
# outbound voice lines and SMS thread memory all live in it, and every
# caller fails open — so without it nothing errors, state just silently
# vanishes between serverless invocations.
#
# Getting there used to be five steps across four tools, and two of them
# were untrustworthy:
#
#   - sync-ssm-to-vercel.sh PRINTS "trigger a redeploy" and exits 0, so
#     skipping the redeploy leaves the env set and the deployment stale.
#   - `npm run check:line` hydrates SSM into its own process and reports
#     on THAT, so it prints a green "upstash" for the machine you ran it
#     on while prod is still serving in-memory KV.
#
# This script does the whole chain and then asks PRODUCTION whether it
# worked, via /health?deep=1. It exits non-zero unless the deployed tier
# reports a durable backend with a working round-trip — the exit code
# means "prod has durable KV", not "I ran some commands".
#
# Safe to re-run: the audit skips what exists, the SSM write never
# overwrites, and the verify step is read-only apart from a 60s canary key.
#
# USAGE:
#   ./scripts/kv-setup.sh                     # full chain, prod
#   ./scripts/kv-setup.sh --verify-only       # just ask prod how it's doing
#   ./scripts/kv-setup.sh --stage test
#   EDGE_HOST=cotrackpro-talk.vercel.app ./scripts/kv-setup.sh
#
# REQUIREMENTS: aws CLI + credentials (AWS CloudShell already has these).
# `gh` is used to fire the deploy workflows if present; without it the
# script prints the exact commands instead.

set -uo pipefail

STAGE="${STAGE:-prod}"
REGION="${AWS_REGION:-us-east-1}"
EDGE_HOST="${EDGE_HOST:-}"
VERIFY_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1; shift ;;
    --stage) STAGE="${2:?--stage needs a value}"; shift 2 ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --host) EDGE_HOST="${2:?--host needs a value}"; shift 2 ;;
    # Print the header block: everything after the shebang, up to the
    # first line that isn't a comment. A line range would drift the
    # moment the header grows.
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
done

case "$STAGE" in
  prod|test) ;;
  *) echo "ERROR: --stage must be 'prod' or 'test' (got '$STAGE')" >&2; exit 2 ;;
esac

PREFIX="/cotrackpro/${STAGE}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

c_g(){ printf '\033[32m%s\033[0m\n' "$*"; }
c_r(){ printf '\033[31m%s\033[0m\n' "$*"; }
c_y(){ printf '\033[33m%s\033[0m\n' "$*"; }
c_b(){ printf '\033[1m%s\033[0m\n'  "$*"; }
step(){ echo; c_b "── $* ─────────────────────────────────────────"; }

ssm(){ aws ssm get-parameter --region "$REGION" --name "$1" --with-decryption \
         --query Parameter.Value --output text 2>/dev/null; }

# Type only — no decryption, so this needs GetParameter alone.
ssm_exists(){
  [[ -n "$(aws ssm get-parameter --region "$REGION" --name "$1" \
             --query 'Parameter.Type' --output text 2>/dev/null)" ]]
}

command -v aws >/dev/null 2>&1 || {
  c_r "ERROR: the 'aws' CLI is not on PATH."
  echo "       Run this from AWS CloudShell, which has it preinstalled and authenticated."
  exit 2
}
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || {
  c_r "ERROR: no working AWS credentials for region ${REGION}."
  exit 2
}

ask_host(){
  while [[ -z "$EDGE_HOST" ]]; do
    read -rp "Edge host (bare, e.g. cotrackpro-talk.vercel.app): " EDGE_HOST
    case "$EDGE_HOST" in
      ""|*://*|*/*) c_r "  bare host only — no https:// and no slashes"; EDGE_HOST="";;
    esac
  done
}

# ── 1. Audit ─────────────────────────────────────────────────────────────────

have_kv_params(){ ssm_exists "${PREFIX}/kv/url" && ssm_exists "${PREFIX}/kv/token"; }

# ── 2. Provision ─────────────────────────────────────────────────────────────

provision(){
  step "2. Upstash credentials"
  cat <<'TXT'
  In the Upstash console (https://console.upstash.com):

    1. Create database → Redis. Any name; pick the region closest to
       your Vercel deployment. The free tier is enough to start.
    2. Open the database → scroll to the "REST API" panel.
    3. Copy UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.

  Those two become KV_URL and KV_TOKEN. Paste them below — the token is
  read hidden and goes straight to SSM as a SecureString.

TXT

  local url="" token=""
  while [[ -z "$url" ]]; do
    read -rp "  KV_URL   (https://....upstash.io): " url
    case "$url" in
      https://*) ;;
      *) c_r "     must start with https://"; url="";;
    esac
  done
  while [[ -z "$token" ]]; do
    read -rsp "  KV_TOKEN (hidden): " token; echo
    [[ -z "$token" ]] && c_r "     required"
  done

  # Delegate the actual write. ssm-params.sh owns the registry, the
  # String/SecureString typing and the never-overwrite guarantee; a
  # second put-parameter here would be a second place for those to drift.
  KV_URL="$url" KV_TOKEN="$token" \
    "${HERE}/ssm-params.sh" create --from-env --stage "$STAGE" --region "$REGION"
  local rc=$?
  unset url token
  if [[ $rc -ne 0 ]]; then
    c_r "  ssm-params.sh exited ${rc} — parameters may not have been written."
    return 1
  fi
  if ! have_kv_params; then
    c_r "  kv/url + kv/token still not present in SSM. Aborting before deploy."
    return 1
  fi
  c_g "  ✓ kv/url + kv/token are in SSM under ${PREFIX}"
}

# ── 3. Propagate ─────────────────────────────────────────────────────────────

propagate(){
  step "3. Push to the deploy targets"
  if command -v gh >/dev/null 2>&1; then
    echo "  gh found — firing both workflows."
    gh workflow run vercel-env-sync.yml -f stage="$STAGE" \
      && c_g "  ✓ vercel-env-sync.yml dispatched" \
      || c_r "  ✗ vercel-env-sync.yml dispatch failed (auth? wrong repo?)"
    gh workflow run fly-deploy.yml \
      && c_g "  ✓ fly-deploy.yml dispatched" \
      || c_r "  ✗ fly-deploy.yml dispatch failed"
    echo "  Watch: gh run list --limit 5"
  else
    c_y "  gh is not on PATH. Run these yourself:"
    echo "    gh workflow run vercel-env-sync.yml -f stage=${STAGE}"
    echo "    gh workflow run fly-deploy.yml"
    echo "  or, with VERCEL_TOKEN exported:"
    echo "    ./scripts/sync-ssm-to-vercel.sh ${STAGE}"
  fi

  echo
  c_y "  ⚠  Vercel applies env vars to NEW deployments only. Syncing the"
  c_y "     env is not enough — redeploy (Deployments → ⋯ → Redeploy, or"
  c_y "     push a commit). This is the step that silently sinks the chain;"
  c_y "     the verify below is what catches it."
}

# ── 4. Verify against production ─────────────────────────────────────────────

verify(){
  step "4. Ask production"
  ask_host

  local bearer; bearer="$(ssm "${PREFIX}/talk/outbound_api_key")"
  if [[ -z "$bearer" || "$bearer" == "None" ]]; then
    c_r "  Can't read ${PREFIX}/talk/outbound_api_key — the deep check needs it."
    return 1
  fi

  local url="https://${EDGE_HOST}/health?deep=1"
  echo "  GET ${url}"

  local attempt=0 max=10 delay=5 code body
  while :; do
    attempt=$((attempt + 1))
    body="$(curl -s -m 20 -w $'\n%{http_code}' -H "Authorization: Bearer ${bearer}" "$url")"
    code="$(printf '%s' "$body" | tail -n1)"
    body="$(printf '%s' "$body" | sed '$d')"

    if [[ "$code" == "200" ]]; then
      c_g "  ✅ durable — production round-tripped a key."
      echo "     $body"
      return 0
    fi

    if [[ $attempt -ge $max ]]; then
      break
    fi
    printf '  attempt %d/%d → HTTP %s, retrying in %ds…\n' "$attempt" "$max" "$code" "$delay"
    sleep "$delay"
    [[ $delay -lt 30 ]] && delay=$((delay * 2))
  done

  echo
  c_r "  ❌ production is NOT reporting durable KV after ${max} attempts."
  echo "     Last: HTTP ${code}"
  echo "     ${body}"
  echo
  case "$code" in
    503)
      c_y "  503 means the function answered and told you it isn't durable."
      c_y "  In order of likelihood:"
      c_y "    1. Env synced but NOT redeployed — Vercel only applies env to"
      c_y "       new deployments. Redeploy, then re-run --verify-only."
      c_y "    2. The sync workflow hasn't finished. Check: gh run list --limit 5"
      c_y "    3. The token is wrong — a 'probe' error mentioning WRONGPASS or"
      c_y "       401 means Upstash rejected it. Fix the value in the AWS console"
      c_y "       (this script never overwrites) and re-sync."
      ;;
    401) c_y "  401 — Vercel's TALK_OUTBOUND_API_KEY doesn't match SSM. Re-run the env sync." ;;
    000) c_y "  Couldn't reach ${EDGE_HOST} — wrong host, or DNS." ;;
    404) c_y "  404 — this deploy predates /health?deep=1. Deploy the current branch first." ;;
    *)   c_y "  Unexpected status; see the body above." ;;
  esac
  return 1
}

# ── Main ─────────────────────────────────────────────────────────────────────

c_b "CoTrackPro talk — durable KV setup   stage=${STAGE} region=${REGION}"

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  verify; exit $?
fi

step "1. Audit SSM"
if have_kv_params; then
  c_g "  ✓ ${PREFIX}/kv/url and ${PREFIX}/kv/token already exist — skipping provisioning."
  echo "    (To change a value, edit it in the AWS console: this script and"
  echo "     ssm-params.sh both refuse to overwrite, by design.)"
else
  echo "  kv/url and/or kv/token are missing."
  provision || exit 1
fi

propagate
verify || exit 1

echo
c_g "Done — production has durable KV."
echo "Now confirm the behavior it's for: text STOP to your number, then text"
echo "it again. The second message should be suppressed — that only works if"
echo "the opt-out survived across two separate serverless invocations."
