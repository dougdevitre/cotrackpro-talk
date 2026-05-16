/**
 * scripts/show-twilio-number.ts
 *
 * Read-only companion to configure-twilio-number.ts. Prints the
 * current voice webhook + status callback for a Twilio number so
 * operators can verify provisioning without leaving the terminal.
 *
 * USAGE:
 *   npm run show:twilio -- +13143948500
 *   npx tsx scripts/show-twilio-number.ts +13143948500
 *
 * REQUIREMENTS:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 */

import "dotenv/config";
import twilio from "twilio";
import { env } from "../src/config/env.js";

async function main(): Promise<void> {
  const phone = process.argv[2];
  if (!phone) {
    console.error("Usage: tsx scripts/show-twilio-number.ts <+E164>");
    process.exit(2);
  }

  const client = twilio(env.twilioAccountSid, env.twilioAuthToken);
  const matches = await client.incomingPhoneNumbers.list({ phoneNumber: phone });
  if (!matches.length) {
    console.error(`No Twilio number matches ${phone} on account ${env.twilioAccountSid}`);
    process.exit(1);
  }
  const n = matches[0]!;
  console.log(JSON.stringify({
    phoneNumber:          n.phoneNumber,
    friendlyName:         n.friendlyName,
    sid:                  n.sid,
    voiceUrl:             n.voiceUrl,
    voiceMethod:          n.voiceMethod,
    voiceFallbackUrl:     n.voiceFallbackUrl,
    statusCallback:       n.statusCallback,
    statusCallbackMethod: n.statusCallbackMethod,
    smsUrl:               n.smsUrl,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
