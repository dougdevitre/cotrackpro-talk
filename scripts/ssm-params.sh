#!/usr/bin/env bash
# scripts/ssm-params.sh
#
# Audit — and optionally create — the AWS SSM parameters this app reads.
#
# SSM is the single source of truth for talk's config: the Fly WS tier
# pulls from it at deploy (.github/workflows/fly-deploy.yml) and the Vercel
# HTTP tier gets it mirrored in by scripts/sync-ssm-to-vercel.sh. A missing
# parameter doesn't crash anything loudly — it degrades quietly (wrong
# voice, silent call, SMS that forgets the last message), which is why this
# audit exists.
#
# USAGE:
#   ./scripts/ssm-params.sh                      # audit prod, write nothing
#   ./scripts/ssm-params.sh check --stage test
#   ./scripts/ssm-params.sh create               # prompt for MISSING params only
#   ./scripts/ssm-params.sh create --from-env    # take values from env vars, no prompts
#
# SAFETY: this NEVER overwrites an existing parameter. `create` only writes
# names the audit just reported as absent, and put-parameter is called
# without --overwrite so a concurrent create still loses safely. To change
# an existing value, use the AWS console or an explicit put-parameter
# --overwrite by hand — deliberately not automated here.
#
# The audit reads parameter TYPE, not VALUE, for secrets — so it needs only
# ssm:GetParameter, no kms:Decrypt. Values are displayed only for the
# non-secret (String) parameters, where seeing the value is the point.
#
# REQUIREMENTS: aws CLI + credentials with ssm:GetParameter (audit) and
# ssm:PutParameter (create) on /cotrackpro/<stage>/*. AWS CloudShell already
# has these.

set -uo pipefail

ACTION="check"
STAGE="prod"
REGION="${AWS_REGION:-us-east-1}"
FROM_ENV=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    check|create) ACTION="$1"; shift ;;
    --stage) STAGE="${2:?--stage needs a value}"; shift 2 ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --from-env) FROM_ENV=1; shift ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
done

case "$STAGE" in
  prod|test) ;;
  *) echo "ERROR: --stage must be 'prod' or 'test' (got '$STAGE')" >&2; exit 2 ;;
esac

PREFIX="/cotrackpro/${STAGE}"

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: the 'aws' CLI is not on PATH. Run this from AWS CloudShell," >&2
  echo "       or install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2
  exit 2
fi

# ── Registry ─────────────────────────────────────────────────────────────────
#
# Fields, colon-separated:
#   suffix | env var | type | tier | tier-class | one-line purpose
#
# tier-class:
#   required — the line is broken or non-compliant without it
#   voice    — the line works, but not the way you configured it
#   memory   — SMS conversation loses context between messages
#   optional — nice to have
#
# `suffix` may list alternates separated by "|" — the first that exists
# wins. That exists for exactly one parameter: the Anthropic key, which
# fly-deploy.yml reads at ai/anthropic/api_key while the Vercel sync reads
# it at anthropic/api_key. See the drift warning at the end of the audit.

REGISTRY=(
  "twilio/account_sid:TWILIO_ACCOUNT_SID:SecureString:fly+vercel:required:Twilio API auth"
  "twilio/auth_token:TWILIO_AUTH_TOKEN:SecureString:fly+vercel:required:Twilio API auth + webhook signature validation"
  "twilio/phone_number:TWILIO_PHONE_NUMBER:String:fly+vercel:required:The number itself"
  "twilio/messaging_service_sid:TWILIO_MESSAGING_SERVICE_SID:String:vercel:required:A2P 10DLC attribution — prod SMS sends refuse without it"
  "elevenlabs/api_key:ELEVENLABS_API_KEY:SecureString:fly+vercel:required:TTS + STT"
  "ai/anthropic/api_key|anthropic/api_key:ANTHROPIC_API_KEY:SecureString:fly+vercel:required:Claude — both the voice and SMS conversation"
  "talk/outbound_api_key:TALK_OUTBOUND_API_KEY:SecureString:vercel:required:Shared hub<->talk bearer, both directions"
  "talk/ws_domain:WS_DOMAIN:String:vercel:required:Host serving the media stream. Unset means Vercel's TwiML streams to Vercel, which cannot serve it — the call connects and goes silent"
  "voice/inbound_phone_map:INBOUND_PHONE_VOICE_MAP:String:fly+vercel:voice:Pins the ElevenLabs voice + role per number. Unset means every call answers in the stock default voice"
  "elevenlabs/voice_id_doug:ELEVENLABS_VOICE_ID_DOUG:String:vercel:voice:Doug's cloned voice for outbound reminder calls"
  "kv/url:KV_URL:String:fly+vercel:memory:Shared KV (Upstash option). NOT needed if you run the DynamoDB backend — see the note below"
  "kv/token:KV_TOKEN:SecureString:fly+vercel:memory:Shared KV auth (Upstash option)"
  "talk/server_domain:SERVER_DOMAIN:String:vercel:optional:Single-host fallback domain"
)

# Value hints shown when prompting for a missing parameter.
hint_for() {
  case "$1" in
    talk/ws_domain)          echo "the long-running WS host, no scheme — e.g. cotrackpro-talk.fly.dev" ;;
    voice/inbound_phone_map) echo 'JSON, e.g. {"+13143948500":{"voiceId":"<elevenlabs-voice-id>","role":"parent"}}' ;;
    kv/url)                  echo "Upstash/Vercel KV REST URL — e.g. https://xxx.upstash.io" ;;
    kv/token)                echo "Upstash/Vercel KV REST token" ;;
    twilio/phone_number)     echo "E.164 — e.g. +13143948500" ;;
    twilio/messaging_service_sid) echo "starts with MG" ;;
    elevenlabs/voice_id_doug|*/voice_id*) echo "16-32 alphanumeric ElevenLabs voice id" ;;
    talk/server_domain)      echo "public host, no scheme — e.g. talk.cotrackpro.com" ;;
    *)                       echo "" ;;
  esac
}

# ── Probe ────────────────────────────────────────────────────────────────────

# Echo the parameter's type if it exists, nothing if it doesn't. No
# decryption, so this works with GetParameter alone.
ssm_type() {
  aws ssm get-parameter --region "$REGION" --name "$1" \
    --query 'Parameter.Type' --output text 2>/dev/null
}

# Echo a String parameter's value (never called for SecureString).
ssm_value() {
  aws ssm get-parameter --region "$REGION" --name "$1" \
    --query 'Parameter.Value' --output text 2>/dev/null
}

echo "SSM audit — ${PREFIX}/* (${REGION})"
echo

if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
  echo "ERROR: no working AWS credentials for region ${REGION}." >&2
  echo "       Run this from AWS CloudShell, or export credentials first." >&2
  exit 2
fi

declare -a MISSING_SUFFIX=() MISSING_NAME=() MISSING_TYPE=() MISSING_CLASS=()
missing_required=0
missing_other=0
found_anthropic_at=""
legacy_anthropic=0

for entry in "${REGISTRY[@]}"; do
  IFS=':' read -r suffixes name ptype tier class purpose <<<"$entry"

  # Resolve alternates: first path that exists wins.
  resolved=""
  IFS='|' read -ra candidates <<<"$suffixes"
  for cand in "${candidates[@]}"; do
    if [[ -n "$(ssm_type "${PREFIX}/${cand}")" ]]; then
      resolved="$cand"
      break
    fi
  done

  primary="${candidates[0]}"

  if [[ -n "$resolved" ]]; then
    detail=""
    if [[ "$ptype" == "String" ]]; then
      v="$(ssm_value "${PREFIX}/${resolved}")"
      # Truncate long values (the phone map) so the table stays readable.
      if [[ ${#v} -gt 68 ]]; then detail="= ${v:0:65}..."; else detail="= ${v}"; fi
    else
      detail="= (SecureString, not read)"
    fi
    printf '  ✓ %-34s %-30s %s\n' "$resolved" "$name" "$detail"
    if [[ "$name" == "ANTHROPIC_API_KEY" ]]; then
      found_anthropic_at="$resolved"
      [[ "$resolved" != "$primary" ]] && legacy_anthropic=1
    fi
  else
    printf '  ✗ %-34s %-30s MISSING [%s]\n' "$primary" "$name" "$class"
    printf '      %s\n' "$purpose"
    MISSING_SUFFIX+=("$primary")
    MISSING_NAME+=("$name")
    MISSING_TYPE+=("$ptype")
    MISSING_CLASS+=("$class")
    if [[ "$class" == "required" ]]; then
      missing_required=$((missing_required + 1))
    else
      missing_other=$((missing_other + 1))
    fi
  fi
done

echo
echo "${#MISSING_SUFFIX[@]} missing (${missing_required} required, ${missing_other} other)"

# kv/* is only ONE of two ways to get a durable KV backend, and the other
# one doesn't touch SSM at all — so "MISSING" here is not proof that the
# app is running on the in-memory backend. Say so, rather than sending an
# operator off to provision Upstash they may not need.
kv_missing=0
for s in "${MISSING_SUFFIX[@]:-}"; do
  [[ "$s" == kv/* ]] && kv_missing=1
done
if [[ "$kv_missing" -eq 1 ]]; then
  echo
  echo "  NOTE: kv/* covers the Upstash option only. The DynamoDB backend"
  echo "        (KV_BACKEND=dynamo + KV_DYNAMO_TABLE, set directly in the"
  echo "        Vercel env) needs no SSM parameters, so these can be"
  echo "        legitimately absent. A durable backend is MANDATORY either"
  echo "        way — STOP suppression and send idempotency both depend on"
  echo "        it. To see which backend is actually live:"
  echo "          npm run check:line -- <your +E164 number>"
fi

# Known drift between the two deploy paths: fly-deploy.yml reads the
# Anthropic key from ai/anthropic/api_key, sync-ssm-to-vercel.sh reads it
# from anthropic/api_key. The sync script now tries both, but flag it so
# the registry gets normalized rather than quietly depending on a fallback.
if [[ "$legacy_anthropic" -eq 1 ]]; then
  echo
  echo "  NOTE: ANTHROPIC_API_KEY resolved at the LEGACY path ${found_anthropic_at}."
  echo "        fly-deploy.yml reads ai/anthropic/api_key. Copy it there so both"
  echo "        deploy paths agree:"
  echo "          v=\$(aws ssm get-parameter --region ${REGION} \\"
  echo "                --name ${PREFIX}/${found_anthropic_at} --with-decryption \\"
  echo "                --query Parameter.Value --output text)"
  echo "          aws ssm put-parameter --region ${REGION} \\"
  echo "                --name ${PREFIX}/ai/anthropic/api_key \\"
  echo "                --type SecureString --value \"\$v\"; unset v"
fi

if [[ "$ACTION" == "check" ]]; then
  if [[ ${#MISSING_SUFFIX[@]} -gt 0 ]]; then
    echo
    echo "To create the missing ones (prompts per value, never overwrites):"
    echo "  ./scripts/ssm-params.sh create --stage ${STAGE}"
  fi
  [[ "$missing_required" -eq 0 ]] && exit 0 || exit 1
fi

# ── Create ───────────────────────────────────────────────────────────────────

if [[ ${#MISSING_SUFFIX[@]} -eq 0 ]]; then
  echo "Nothing to create."
  exit 0
fi

echo
echo "Creating ${#MISSING_SUFFIX[@]} missing parameter(s) under ${PREFIX}."
echo "Existing parameters are never touched. Empty input skips a parameter."
echo

created=0
skipped=0

for i in "${!MISSING_SUFFIX[@]}"; do
  suffix="${MISSING_SUFFIX[$i]}"
  name="${MISSING_NAME[$i]}"
  ptype="${MISSING_TYPE[$i]}"
  path="${PREFIX}/${suffix}"
  hint="$(hint_for "$suffix")"

  value=""
  if [[ "$FROM_ENV" -eq 1 ]]; then
    value="${!name:-}"
    if [[ -z "$value" ]]; then
      echo "  skip  ${name} (env var not set)"
      skipped=$((skipped + 1))
      continue
    fi
  else
    echo "  ${name}  →  ${path}  [${ptype}]"
    [[ -n "$hint" ]] && echo "     ${hint}"
    if [[ "$ptype" == "SecureString" ]]; then
      # -s so the secret never lands on screen or in scrollback.
      read -rsp "     value (hidden, blank to skip): " value
      echo
    else
      read -rp "     value (blank to skip): " value
    fi
    if [[ -z "$value" ]]; then
      echo "     skipped"
      skipped=$((skipped + 1))
      echo
      continue
    fi
  fi

  # No --overwrite: if the parameter appeared since the audit, this fails
  # and we report it rather than clobbering a value we never saw.
  if aws ssm put-parameter \
      --region "$REGION" \
      --name "$path" \
      --type "$ptype" \
      --value "$value" \
      --description "CoTrackPro talk — ${name}" \
      >/dev/null 2>&1; then
    echo "     created ${path}"
    created=$((created + 1))
  else
    echo "     FAILED to create ${path} (already exists, or no ssm:PutParameter permission)" >&2
  fi
  echo
done

echo "Done. ${created} created, ${skipped} skipped."
if [[ "$created" -gt 0 ]]; then
  echo
  echo "Next — nothing reads SSM at runtime, so push the values out:"
  echo "  1. Vercel:  gh workflow run vercel-env-sync.yml -f stage=${STAGE}"
  echo "              (or ./scripts/sync-ssm-to-vercel.sh ${STAGE} with VERCEL_TOKEN set)"
  echo "  2. Fly:     gh workflow run fly-deploy.yml"
  echo "  3. Verify:  npm run check:line -- <your +E164 number>"
fi
