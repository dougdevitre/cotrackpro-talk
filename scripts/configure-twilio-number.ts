/**
 * scripts/configure-twilio-number.ts
 *
 * One-shot provisioner that points a Twilio number's voice AND SMS
 * webhooks at this app. Use any time you add a new number, change
 * API_DOMAIN, or move the app between environments — keeps the Twilio
 * console out of the loop so the mapping is reproducible across
 * prod/staging.
 *
 * USAGE:
 *   npm run configure:twilio -- +13143948500
 *   npx tsx scripts/configure-twilio-number.ts +13143948500
 *
 * REQUIREMENTS (from env / .env):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   API_DOMAIN (or SERVER_DOMAIN)
 *
 * Webhooks set (all POST):
 *   voiceUrl       → https://$API_DOMAIN/call/incoming
 *   statusCallback → https://$API_DOMAIN/call/status
 *   smsUrl         → https://$API_DOMAIN/sms/incoming
 *
 * ⚠️  Messaging Service caveat: if this number is attached to an A2P
 * Messaging Service (which it MUST be for compliant outbound SMS), the
 * Messaging Service's *Integration → inbound request URL* overrides the
 * number-level smsUrl this script sets. In that topology, point the
 * Messaging Service inbound webhook at https://$API_DOMAIN/sms/incoming
 * in the console (or via the Messaging Services API) instead — the
 * number-level smsUrl set here is the fallback for numbers not in a
 * service. See docs/GO_LIVE-sms-voice-reminders.md.
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
  const smsUrl = `https://${env.apiDomain}/sms/incoming`;

  const updated = await client.incomingPhoneNumbers(number.sid).update({
    voiceUrl,
    voiceMethod: "POST",
    statusCallback,
    statusCallbackMethod: "POST",
    smsUrl,
    smsMethod: "POST",
  });

  console.log(`Configured ${updated.phoneNumber}`);
  console.log(`  sid:            ${updated.sid}`);
  console.log(`  voiceUrl:       ${updated.voiceUrl}`);
  console.log(`  statusCallback: ${updated.statusCallback}`);
  console.log(`  smsUrl:         ${updated.smsUrl}`);
  console.warn(
    `\n  ⚠️  If ${updated.phoneNumber} is in an A2P Messaging Service, that ` +
      `service's\n      inbound URL OVERRIDES the number-level smsUrl above. ` +
      `Point the Messaging\n      Service inbound webhook at ${smsUrl} instead. ` +
      `See docs/GO_LIVE-sms-voice-reminders.md.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
