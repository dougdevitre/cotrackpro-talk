/**
 * scripts/show-a2p-status.ts
 *
 * Read-only A2P 10DLC / TrustHub status check for outbound SMS. Confirms
 * the Messaging Service, A2P Brand, and Campaign that CoTrackPro sends
 * through are registered and APPROVED — so "is TrustHub connected?" is a
 * one-command, reproducible answer instead of clicking through the
 * Twilio console.
 *
 * Reads identifiers from the ENVIRONMENT (deliberately NOT
 * src/config/env.ts, so it runs without the full app env). The canonical
 * source is SSM under /cotrackpro/<stage>/twilio/* — pull them first:
 *
 *   STAGE=prod REGION=us-east-1
 *   for k in account_sid auth_token messaging_service_sid brand_sid campaign_sid; do
 *     export "TWILIO_$(echo "$k" | tr 'a-z' 'A-Z')=$(aws ssm get-parameter \
 *       --region "$REGION" --name "/cotrackpro/$STAGE/twilio/$k" \
 *       --with-decryption --query Parameter.Value --output text)"
 *   done
 *   npm run show:a2p
 *
 * REQUIREMENTS (env):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN    (required)
 *   TWILIO_MESSAGING_SERVICE_SID             (MG…, required)
 *   TWILIO_BRAND_SID                         (BN…, recommended)
 *   TWILIO_CAMPAIGN_SID                      (optional; cross-checked vs the service)
 *
 * SECURITY: the auth token is never printed. SIDs and statuses are not
 * secret. Exits non-zero if anything that would block compliant sending
 * is missing/not-approved.
 */

import "dotenv/config";
import twilio from "twilio";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const accountSid = need("TWILIO_ACCOUNT_SID");
  const authToken = need("TWILIO_AUTH_TOKEN");
  const serviceSid = need("TWILIO_MESSAGING_SERVICE_SID");
  const brandSid = process.env.TWILIO_BRAND_SID ?? "";
  const wantCampaignSid = process.env.TWILIO_CAMPAIGN_SID ?? "";

  const client = twilio(accountSid, authToken);
  let problems = 0;

  // ── Messaging Service ────────────────────────────────────────────────
  console.log(`Messaging Service ${serviceSid}`);
  try {
    const svc = (await client.messaging.v1
      .services(serviceSid)
      .fetch()) as unknown as { friendlyName?: string };
    console.log(`  friendlyName: ${svc.friendlyName ?? "(none)"}`);
  } catch (err) {
    problems++;
    console.log(`  ERROR fetching service: ${msg(err)}`);
  }

  // Sender pool (the number(s) SMS goes out from).
  try {
    const numbers = await client.messaging.v1
      .services(serviceSid)
      .phoneNumbers.list({ limit: 50 });
    const pool = numbers
      .map((n) => (n as unknown as { phoneNumber?: string }).phoneNumber)
      .filter((p): p is string => Boolean(p));
    console.log(
      `  sender pool:  ${pool.length} number(s)${pool.length ? " — " + pool.join(", ") : ""}`,
    );
    if (pool.length === 0) problems++;
  } catch (err) {
    problems++;
    console.log(`  ERROR listing sender pool: ${msg(err)}`);
  }

  // ── A2P Campaign (us_app_to_person) attached to the service ──────────
  const foundCampaigns: string[] = [];
  try {
    const campaigns = (await client.messaging.v1
      .services(serviceSid)
      .usAppToPerson.list({ limit: 20 })) as unknown as Array<{
      sid?: string;
      campaignStatus?: string;
      usAppToPersonUsecase?: string;
      brandRegistrationSid?: string;
    }>;
    if (campaigns.length === 0) {
      problems++;
      console.log("A2P Campaign: NONE attached to this Messaging Service");
    }
    for (const c of campaigns) {
      if (c.sid) foundCampaigns.push(c.sid);
      console.log(`A2P Campaign ${c.sid ?? "?"}`);
      console.log(`  status:   ${c.campaignStatus ?? "?"}`);
      console.log(`  usecase:  ${c.usAppToPersonUsecase ?? "?"}`);
      console.log(`  brand:    ${c.brandRegistrationSid ?? "?"}`);
      if ((c.campaignStatus ?? "").toUpperCase() !== "VERIFIED") problems++;
    }
  } catch (err) {
    problems++;
    console.log(`A2P Campaign: ERROR ${msg(err)}`);
  }

  // Cross-check the configured campaign SID actually lives on this service.
  if (wantCampaignSid && !foundCampaigns.includes(wantCampaignSid)) {
    problems++;
    console.log(
      `  WARNING: configured TWILIO_CAMPAIGN_SID ${wantCampaignSid} is not attached to ${serviceSid}`,
    );
  }

  // ── A2P Brand registration ──────────────────────────────────────────
  if (brandSid) {
    console.log(`A2P Brand ${brandSid}`);
    try {
      const b = (await client.messaging.v1
        .brandRegistrations(brandSid)
        .fetch()) as unknown as {
        status?: string;
        identityStatus?: string;
        failureReason?: string;
      };
      console.log(`  status:        ${b.status ?? "?"}`);
      console.log(`  identity:      ${b.identityStatus ?? "?"}`);
      if (b.failureReason) console.log(`  failureReason: ${b.failureReason}`);
      if ((b.status ?? "").toUpperCase() !== "APPROVED") problems++;
    } catch (err) {
      problems++;
      console.log(`  ERROR fetching brand: ${msg(err)}`);
    }
  } else {
    console.log("A2P Brand: (TWILIO_BRAND_SID not set — skipping)");
  }

  // ── Verdict ─────────────────────────────────────────────────────────
  console.log("");
  if (problems === 0) {
    console.log(
      "✓ A2P/TrustHub looks CONNECTED: brand approved, campaign verified, sender pool present.",
    );
  } else {
    console.log(
      `✗ ${problems} issue(s) found — see above. SMS may be rejected or unattributed until resolved.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(msg(err));
  process.exit(1);
});
