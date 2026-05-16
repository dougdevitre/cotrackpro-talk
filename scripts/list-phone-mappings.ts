/**
 * scripts/list-phone-mappings.ts
 *
 * Print the active INBOUND_PHONE_VOICE_MAP as a human-readable table.
 * Reads from process.env using the same parser the runtime uses, so
 * what you see here is what /call/incoming would see for an incoming
 * Twilio webhook.
 *
 * USAGE:
 *   npm run list:phones
 *   npm run list:phones -- --json
 *
 * EXIT CODES:
 *   0   empty map or printed successfully (always; this is read-only)
 */

import "dotenv/config";
// Pure module so the script runs without a fully-populated prod env.
import { parseInboundPhoneMapLenient } from "../src/config/inboundPhoneMapPure.js";

const asJson = process.argv.includes("--json");
const map = parseInboundPhoneMapLenient(process.env.INBOUND_PHONE_VOICE_MAP);
const entries = Object.entries(map);

if (asJson) {
  console.log(JSON.stringify(map, null, 2));
  process.exit(0);
}

if (entries.length === 0) {
  process.stderr.write("(no inbound phone overrides configured)\n");
  process.exit(0);
}

const headers = ["PHONE", "ROLE", "VOICE_ID"];
const rows = entries.map(([phone, e]) => [phone, e.role, e.voiceId]);
const widths = headers.map((h, i) =>
  Math.max(h.length, ...rows.map((r) => r[i]!.length)),
);

function fmt(cells: string[]): string {
  return cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
}

console.log(fmt(headers));
console.log(fmt(widths.map((w) => "-".repeat(w))));
for (const row of rows) console.log(fmt(row));
