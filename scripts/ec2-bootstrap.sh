#!/usr/bin/env bash
# scripts/ec2-bootstrap.sh — EC2 first-boot bootstrap for the CoTrackPro
# Talk VOICE tier. Runs as root via cloud-init user-data (injected by
# scripts/deploy-ec2.sh). It:
#   1. installs Docker + git,
#   2. builds the app image from the PUBLIC repo,
#   3. pulls runtime secrets from SSM via the instance IAM role,
#   4. runs the app container + a Caddy container that terminates TLS
#      (automatic Let's Encrypt) and reverse-proxies to the app, handling
#      the Twilio Media Stream WebSocket upgrade transparently.
#
# Not meant to be run by hand — deploy-ec2.sh embeds it as user-data and
# prepends `export VOICE_DOMAIN=... STAGE=...`. Defaults below match
# deploy-ec2.sh so it also works unmodified.
set -uxo pipefail
exec >>/var/log/cotrackpro-bootstrap.log 2>&1
echo "=== cotrackpro voice bootstrap $(date -u) ==="

DOMAIN="${VOICE_DOMAIN:-voice.cotrackpro.com}"
STAGE="${STAGE:-prod}"
PREFIX="/cotrackpro/${STAGE}"
REPO="${REPO_URL:-https://github.com/dougdevitre/cotrackpro-talk.git}"

# Region from IMDSv2 (instance metadata).
TOK="$(curl -sS -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')"
REGION="$(curl -sS -H "X-aws-ec2-metadata-token: $TOK" http://169.254.169.254/latest/meta-data/placement/region)"
export AWS_DEFAULT_REGION="$REGION"
echo "region=$REGION domain=$DOMAIN stage=$STAGE"

# 1) Docker + git (Amazon Linux 2023).
dnf install -y docker git
systemctl enable --now docker
docker network create web 2>/dev/null || true

# 2) Build the app image from the public repo.
rm -rf /opt/app
git clone --depth 1 "$REPO" /opt/app
( cd /opt/app && docker build -t cotrackpro-talk:latest . )

# 3) Runtime secrets from SSM (instance role provides creds) -> env file.
ssm() { aws ssm get-parameter --region "$REGION" --name "$PREFIX/$1" --with-decryption --query Parameter.Value --output text 2>/dev/null; }
ENVF=/opt/app.env
: > "$ENVF"
add() { local v; v="$(ssm "$1")"; if [ -n "$v" ] && [ "$v" != "None" ]; then printf '%s=%s\n' "$2" "$v" >> "$ENVF"; fi; }
add twilio/account_sid           TWILIO_ACCOUNT_SID
add twilio/auth_token            TWILIO_AUTH_TOKEN
add twilio/phone_number          TWILIO_PHONE_NUMBER
add twilio/messaging_service_sid TWILIO_MESSAGING_SERVICE_SID
add elevenlabs/api_key           ELEVENLABS_API_KEY
add elevenlabs/voice_id_doug     ELEVENLABS_VOICE_ID_DOUG
add anthropic/api_key            ANTHROPIC_API_KEY
add talk/outbound_api_key        TALK_OUTBOUND_API_KEY
{
  echo "NODE_ENV=production"
  echo "PORT=8080"
  echo "SERVER_DOMAIN=$DOMAIN"
  echo "HUB_BASE_URL=https://cotrackpro.com"
  echo "COTRACKPRO_MCP_URL=https://mcp.cotrackpro.com/sse"
} >> "$ENVF"
chmod 600 "$ENVF"

# 4) Run the app (internal; Caddy fronts it) and Caddy (auto-TLS).
docker rm -f app caddy 2>/dev/null || true
docker run -d --name app --restart=always --network web --env-file "$ENVF" cotrackpro-talk:latest

mkdir -p /opt/caddy
cat > /opt/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy app:8080
}
EOF
docker run -d --name caddy --restart=always --network web \
  -p 80:80 -p 443:443 \
  -v /opt/caddy/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data -v caddy_config:/config \
  caddy:2

echo "=== bootstrap complete $(date -u) ==="
