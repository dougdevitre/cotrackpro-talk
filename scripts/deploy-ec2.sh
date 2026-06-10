#!/usr/bin/env bash
# scripts/deploy-ec2.sh — provision an always-on AWS EC2 instance to host the
# CoTrackPro Talk VOICE tier (the Twilio Media Stream WebSocket /call/stream),
# with Caddy auto-TLS. Run from AWS CloudShell (or any aws-authenticated shell).
#
# Why EC2: the long-lived bidirectional audio WebSocket can't run on Vercel,
# and AWS App Runner doesn't support WebSockets. This is the lightest always-on
# AWS host that reuses the existing streaming pipeline as-is.
#
# Hybrid topology: Vercel keeps the HTTP edge (talk.cotrackpro.com); this EC2
# box serves wss://<DOMAIN>/call/stream. After it's up, set WS_DOMAIN=<DOMAIN>
# on Vercel so /call/incoming streams audio here.
#
# Requires (CloudShell identity): EC2 + IAM + Route53 + SSM permissions.
# One-shot: aborts if an instance tagged with $NAME already exists.
#
# Usage:  bash scripts/deploy-ec2.sh        (override via env: VOICE_DOMAIN, INSTANCE_TYPE, AWS_REGION)
set -uo pipefail

REGION="${AWS_REGION:-us-east-1}"
STAGE="${STAGE:-prod}"
DOMAIN="${VOICE_DOMAIN:-voice.cotrackpro.com}"
ZONE_APEX="${ZONE_APEX:-cotrackpro.com}"
NAME="${EC2_NAME:-cotrackpro-talk-voice}"
TYPE="${INSTANCE_TYPE:-t3.small}"
ROLE="${EC2_ROLE:-cotrackpro-talk-voice-ec2}"

command -v aws >/dev/null 2>&1 || { echo "ERR: aws CLI not found."; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { echo "ERR: no AWS credentials. Use AWS CloudShell or 'aws configure'."; exit 1; }
[ -f scripts/ec2-bootstrap.sh ] || { echo "ERR: run from the repo root (scripts/ec2-bootstrap.sh not found)."; exit 1; }
echo "region=$REGION  domain=$DOMAIN  type=$TYPE  name=$NAME"

# 0) Guard against duplicates.
EXIST="$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
if [ -n "$EXIST" ]; then
  echo "An instance named '$NAME' already exists: $EXIST"
  echo "Redeploy by terminating it first:  aws ec2 terminate-instances --region $REGION --instance-ids $EXIST"
  exit 1
fi

# 1) IAM role + instance profile: SSM read on the stage namespace + Session Manager.
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "Creating IAM role $ROLE ..."
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam put-role-policy --role-name "$ROLE" --policy-name ssm-read \
    --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\",\"ssm:GetParametersByPath\"],\"Resource\":\"arn:aws:ssm:${REGION}:*:parameter/cotrackpro/${STAGE}/*\"},{\"Effect\":\"Allow\",\"Action\":\"kms:Decrypt\",\"Resource\":\"*\"}]}"
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  echo "Waiting 15s for IAM propagation..."; sleep 15
fi

# 2) Default VPC + security group (inbound 80/443).
VPC="$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
[ -n "$VPC" ] && [ "$VPC" != "None" ] || { echo "ERR: no default VPC in $REGION."; exit 1; }
SG="$(aws ec2 describe-security-groups --region "$REGION" --filters "Name=group-name,Values=$NAME" "Name=vpc-id,Values=$VPC" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)"
if [ -z "$SG" ] || [ "$SG" = "None" ]; then
  SG="$(aws ec2 create-security-group --region "$REGION" --group-name "$NAME" --description "CoTrackPro voice host" --vpc-id "$VPC" --query GroupId --output text)"
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" --ip-permissions \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null
fi
echo "vpc=$VPC  sg=$SG"

# 3) Latest Amazon Linux 2023 AMI (from the public SSM parameter).
AMI="$(aws ssm get-parameter --region "$REGION" --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)"
echo "ami=$AMI"

# 4) Build user-data (shebang + injected config + bootstrap body) and launch.
UDFILE="$(mktemp)"; trap 'rm -f "$UDFILE"' EXIT
{ printf '#!/usr/bin/env bash\nexport VOICE_DOMAIN=%q STAGE=%q\n' "$DOMAIN" "$STAGE"; tail -n +2 scripts/ec2-bootstrap.sh; } > "$UDFILE"
IID="$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type "$TYPE" \
  --iam-instance-profile "Name=$ROLE" --security-group-ids "$SG" \
  --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --user-data "file://$UDFILE" --query 'Instances[0].InstanceId' --output text)"
echo "launched $IID; waiting for running state..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$IID"

# 5) Elastic IP (stable address) + associate.
ALLOC="$(aws ec2 allocate-address --region "$REGION" --domain vpc --query AllocationId --output text)"
aws ec2 associate-address --region "$REGION" --instance-id "$IID" --allocation-id "$ALLOC" >/dev/null
EIP="$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)"
echo "elastic ip=$EIP"

# 6) Route 53 A record (DNS is Route 53; see README "Custom domain").
ZID="$(aws route53 list-hosted-zones-by-name --dns-name "$ZONE_APEX" --query 'HostedZones[0].Id' --output text | sed 's#/hostedzone/##')"
aws route53 change-resource-record-sets --hosted-zone-id "$ZID" --change-batch \
  "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$DOMAIN\",\"Type\":\"A\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$EIP\"}]}}]}" >/dev/null
echo "dns: $DOMAIN -> $EIP  (zone $ZID)"

cat <<MSG

================================================================
Provisioned. The instance is bootstrapping now (docker build + Let's Encrypt
cert issuance) — give it ~3-5 minutes.

  Verify:  curl -sS https://$DOMAIN/health        # -> {"status":"ok",...}
  Debug:   aws ssm start-session --target $IID
             sudo cat /var/log/cotrackpro-bootstrap.log
             sudo docker logs app ; sudo docker logs caddy

Next, point the Vercel edge at this host and redeploy:
  printf '%s' '$DOMAIN' | vercel env add WS_DOMAIN production --token "\$VERCEL_TOKEN"
  vercel deploy --prod --token "\$VERCEL_TOKEN"

Then call your Twilio number — TwiML will stream audio to wss://$DOMAIN/call/stream.
================================================================
MSG
