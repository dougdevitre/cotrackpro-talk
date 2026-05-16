/**
 * scripts/lint-config.ts
 *
 * Pre-deploy validator for INBOUND_PHONE_VOICE_MAP. Reads from
 * process.env (CI is expected to run `vercel env pull` or otherwise
 * populate the environment first), then runs the strict validator.
 * Exits non-zero on any error so the deploy gate trips before a bad
 * map reaches prod and starts silently dropping overrides.
 *
 * USAGE:
 *   npm run lint:config
 *   INBOUND_PHONE_VOICE_MAP='{"+13143948500":{"voiceId":"...","role":"parent"}}' \
 *     npm run lint:config
 *
 * EXIT CODES:
 *   0   map is empty or valid
 *   1   one or more validation errors (printed to stderr)
 */

import "dotenv/config";
// Import the PURE module so the lint script can run without a fully
// populated prod env. The runtime entry point (inboundPhoneMap.ts)
// imports env + logger and would fail fast on missing API_DOMAIN etc.
import { validateInboundPhoneMap } from "../src/config/inboundPhoneMapPure.js";

const raw = process.env.INBOUND_PHONE_VOICE_MAP;
const result = validateInboundPhoneMap(raw);

if (!result.ok) {
  for (const e of result.errors) {
    process.stderr.write(`  ${e.key ? `[${e.key}] ` : ""}${e.message}\n`);
  }
  process.stderr.write(
    `INBOUND_PHONE_VOICE_MAP: ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}\n`,
  );
  process.exit(1);
}

const count = Object.keys(result.map).length;
console.log(
  `INBOUND_PHONE_VOICE_MAP: OK (${count} ${count === 1 ? "entry" : "entries"})`,
);
