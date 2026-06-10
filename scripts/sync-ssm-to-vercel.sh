#!/usr/bin/env bash
# scripts/sync-ssm-to-vercel.sh
#
# Mirror SHARED config from AWS SSM Parameter Store (the single source of
# truth) into THIS app's Vercel environment at deploy time, because Vercel
# cannot read SSM at runtime.
#
# This MUST stay in lockstep with the hub repo's registry:
#   dougdevitre/cotrackpro-antigravity → docs/ops/ssm-parameters.md
# Use the EXACT parameter names and env var names defined there (and below).
# Never set these in the Vercel dashboard by hand.
#
# USAGE:
#   ./scripts/sync-ssm-to-vercel.sh [STAGE]     # STAGE ∈ {prod, test}, default prod
#
# ENV:
#   AWS credentials  — read-only on the namespaces below (+ kms:Decrypt)
#   AWS_REGION       — optional, defaults to us-east-1
#   VERCEL_TOKEN     — required
#   VERCEL_ORG_ID / VERCEL_PROJECT_ID — set these if your Vercel CLI needs
#                      them to resolve the project non-interactively (CI does).
#
# IAM the CI credential needs (scope to ONLY these prefixes):
#   ssm:GetParameter / ssm:GetParametersByPath + kms:Decrypt on
#     /cotrackpro/<stage>/talk/*
#     /cotrackpro/<stage>/twilio/*
#     /cotrackpro/<stage>/elevenlabs/*
#   Optionally (for the OPTIONAL_MAPPING tier below):
#     /cotrackpro/<stage>/anthropic/*   (for ANTHROPIC_API_KEY)
#   The optional tier is best-effort — if the credential can't read a param
#   (NotFound or AccessDenied), it's skipped, never fatal.
#
# SECURITY: secret values are NEVER echoed. They are read into memory, then
# piped to `vercel env add` via stdin — never passed as CLI args (so they
# can't leak into the process list or shell history). Log lines print only
# the parameter name and ok/missing.

set -euo pipefail

STAGE="${1:-prod}"

# STAGE → Vercel target environment. Small case statement on purpose so the
# mapping is trivial to change.
case "$STAGE" in
  prod) TARGET="production" ;;
  test) TARGET="preview" ;;
  *)
    echo "ERROR: STAGE must be 'prod' or 'test' (got: '${STAGE}')" >&2
    exit 2
    ;;
esac

REGION="${AWS_REGION:-us-east-1}"

# Source-of-truth (SSM suffix under /cotrackpro/<stage>/) → Vercel env var.
# ALL of these are REQUIRED. Keep this list identical to the hub registry.
MAPPING=(
  "talk/outbound_api_key:TALK_OUTBOUND_API_KEY"
  "twilio/account_sid:TWILIO_ACCOUNT_SID"
  "twilio/auth_token:TWILIO_AUTH_TOKEN"
  "twilio/messaging_service_sid:TWILIO_MESSAGING_SERVICE_SID"
  "twilio/phone_number:TWILIO_PHONE_NUMBER"
  "elevenlabs/api_key:ELEVENLABS_API_KEY"
  "elevenlabs/voice_id_doug:ELEVENLABS_VOICE_ID_DOUG"
)

# OPTIONAL, app-local params — mirrored only IF they exist (best-effort; a
# missing one is skipped with a warning and does NOT fail the sync). These are
# NOT part of the shared hub registry; they're config this app needs that also
# happens to live in SSM. The running credential needs read access to these
# paths too (a CloudShell operator already has it; for CI, add them to the IAM
# policy or set the env vars directly in the Vercel dashboard instead).
#   anthropic/api_key  → ANTHROPIC_API_KEY  (env.ts requires it at boot)
#   talk/server_domain → SERVER_DOMAIN      (this edge's own public host)
OPTIONAL_MAPPING=(
  "anthropic/api_key:ANTHROPIC_API_KEY"
  "talk/server_domain:SERVER_DOMAIN"
)

# ── Preflight ───────────────────────────────────────────────────────────────
if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "ERROR: VERCEL_TOKEN is required." >&2
  exit 2
fi
for bin in aws vercel; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: '$bin' CLI not found on PATH." >&2
    exit 2
  fi
done

echo "Syncing SSM /cotrackpro/${STAGE}/ ($REGION) → Vercel env '${TARGET}'"

# ── Phase 1: fetch + validate ALL params BEFORE writing anything ─────────────
# Two phases so that a single missing/empty REQUIRED param means we FAIL
# CLOSED and write NOTHING — no partial, no empty env vars. An empty
# TALK_OUTBOUND_API_KEY silently breaks bearer verification; an empty
# TWILIO_MESSAGING_SERVICE_SID silently breaks A2P-compliant sending.
declare -a NAMES=()
declare -a VALUES=()
missing=0

for entry in "${MAPPING[@]}"; do
  suffix="${entry%%:*}"
  name="${entry##*:}"
  path="/cotrackpro/${STAGE}/${suffix}"

  # Capture value; suppress aws's own stderr so a NotFound error can't leak
  # context into logs. A non-empty value on success → ok.
  if value="$(aws ssm get-parameter \
        --region "$REGION" \
        --name "$path" \
        --with-decryption \
        --query 'Parameter.Value' \
        --output text 2>/dev/null)" && [[ -n "$value" && "$value" != "None" ]]; then
    NAMES+=("$name")
    VALUES+=("$value")
    echo "  fetch ${name} ... ok"
  else
    echo "  fetch ${name} ... MISSING (${path})" >&2
    missing=1
  fi
done

if [[ "$missing" -ne 0 ]]; then
  echo "ERROR: one or more REQUIRED parameters missing/empty — wrote nothing." >&2
  exit 1
fi

# Optional, best-effort tier — append any that exist; skip (don't fail) the rest.
for entry in "${OPTIONAL_MAPPING[@]}"; do
  suffix="${entry%%:*}"
  name="${entry##*:}"
  path="/cotrackpro/${STAGE}/${suffix}"

  if value="$(aws ssm get-parameter \
        --region "$REGION" \
        --name "$path" \
        --with-decryption \
        --query 'Parameter.Value' \
        --output text 2>/dev/null)" && [[ -n "$value" && "$value" != "None" ]]; then
    NAMES+=("$name")
    VALUES+=("$value")
    echo "  fetch ${name} ... ok (optional)"
  else
    echo "  fetch ${name} ... skipped (optional; ${path} not set)"
  fi
done

# ── Phase 2: write to Vercel, idempotently (replace if it exists) ────────────
# Remove-then-add so a re-run yields the same env (true idempotency). The
# value is piped via stdin, never an argv.
for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  value="${VALUES[$i]}"

  vercel env rm "$name" "$TARGET" --yes --token "$VERCEL_TOKEN" >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$name" "$TARGET" --token "$VERCEL_TOKEN" >/dev/null
  echo "  set   ${name} → vercel:${TARGET} ... ok"
done

echo "Done. ${#NAMES[@]} secret(s) reconciled to Vercel '${TARGET}'. Trigger a (re)deploy to pick them up."
