/**
 * scripts/configure-twilio-number.ts
 *
 * One-shot provisioner that points a Twilio number's voice webhook at
 * this app's /call/incoming endpoint. Use any time you add a new
 * number, change API_DOMAIN, or move the app between environments —
 * keeps the Twilio console out of the loop so the mapping is
 * reproducible across prod/staging.
 *
 * USAGE:
 *   npm run configure:twilio -- +13143948500
 *   npx tsx scripts/configure-twilio-number.ts +13143948500
 *
 * REQUIREMENTS (from env / .env):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   API_DOMAIN (or SERVER_DOMAIN)
 *
 * The voice webhook is set to https://$API_DOMAIN/call/incoming and
 * the status callback to https://$API_DOMAIN/call/status. Both are
 * configured as POST.
 */

import "dotenv/config";
import twilio from "twilio";
import { env } from "../src/config/env.js";

async function main(): Promise<void> {
  const phone = process.argv[2];
  if (!phone) {
    console.error("Usage: tsx scripts/configure-twilio-number.ts <+E164>");
    process.exit(2);
  }

  const client = twilio(env.twilioAccountSid, env.twilioAuthToken);
  const matches = await client.incomingPhoneNumbers.list({ phoneNumber: phone });
  if (!matches.length) {
    console.error(`No Twilio number matches ${phone} on account ${env.twilioAccountSid}`);
    process.exit(1);
  }
  const number = matches[0]!;

  const voiceUrl = `https://${env.apiDomain}/call/incoming`;
  const statusCallback = `https://${env.apiDomain}/call/status`;

  const updated = await client.incomingPhoneNumbers(number.sid).update({
    voiceUrl,
    voiceMethod: "POST",
    statusCallback,
    statusCallbackMethod: "POST",
  });

  console.log(`Configured ${updated.phoneNumber}`);
  console.log(`  sid:            ${updated.sid}`);
  console.log(`  voiceUrl:       ${updated.voiceUrl}`);
  console.log(`  statusCallback: ${updated.statusCallback}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
