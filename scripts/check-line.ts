/**
 * scripts/check-line.ts — End-to-end preflight for a CoTrackPro Talk number.
 *
 * Answers one question: "if I call or text this number right now, will I
 * reach a conversational assistant in the ElevenLabs voice I picked?"
 *
 * `show:twilio` prints what Twilio has configured. This goes further and
 * verifies the whole chain that a real call depends on — the Twilio
 * webhooks, the API host that answers them, the WebSocket host that
 * carries the audio, the persona/voice binding for the number, and that
 * the ElevenLabs voice id actually resolves under our API key.
 *
 * USAGE:
 *   npm run check:line -- +13143948500
 *   npm run check:line -- +13143948500 --api-domain talk.cotrackpro.com
 *   npx tsx scripts/check-line.ts +13143948500 --stage test --no-ssm
 *
 * Exits 0 when the line is callable, 1 when any REQUIRED check fails.
 * Warnings (⚠) never fail the run — they flag things that degrade
 * quality or cost, not things that break the call.
 *
 * CONFIG: this reads the same env vars the app does
 * (TWILIO_ACCOUNT_SID/AUTH_TOKEN, ELEVENLABS_API_KEY, ANTHROPIC_API_KEY,
 * API_DOMAIN or SERVER_DOMAIN, WS_DOMAIN, INBOUND_PHONE_VOICE_MAP), but
 * you should not have to hand-build a .env to run a preflight. Anything
 * missing from the environment is hydrated from SSM
 * (/cotrackpro/<stage>/*) via the aws CLI before the app modules load.
 * Pass --no-ssm to skip that and use only the ambient env/.env.
 *
 * Because src/config/env.ts validates and freezes config at IMPORT time,
 * every app module here is loaded through a dynamic import in loadApp(),
 * AFTER hydration. A static import would evaluate env.ts before we had a
 * chance to fill anything in — which is exactly the "Missing required env
 * var: set API_DOMAIN" crash this avoids.
 */

import "dotenv/config";
import { execFileSync } from "node:child_process";
import twilio from "twilio";
import WebSocket from "ws";
import type { CoTrackProRole } from "../src/types/index.js";

// ── Late-bound app modules ────────────────────────────────────────────────────
// Assigned by loadApp() after the env is hydrated. Declared with `!` because
// every use is downstream of that call.

type AppEnv = (typeof import("../src/config/env.js"))["env"];

let env!: AppEnv;
let getVoiceId!: (role: CoTrackProRole) => string;
let lookupInboundPhone!: (
  to: string | undefined,
) => { voiceId: string; role: CoTrackProRole } | null;
let GREETINGS_ULAW!: Record<string, string[]>;
let greetingKey!: (role: string, voiceId: string) => string;
let getRoleGreeting!: (role: CoTrackProRole) => string;
let describeKvBackend!: (typeof import("../src/services/kv.js"))["describeKvBackend"];
let probeKv!: (typeof import("../src/services/kv.js"))["probeKv"];

async function loadApp(): Promise<void> {
  ({ env } = await import("../src/config/env.js"));
  ({ getVoiceId } = await import("../src/config/voices.js"));
  ({ lookupInboundPhone } = await import("../src/config/inboundPhoneMap.js"));
  ({ GREETINGS_ULAW, greetingKey } = await import("../src/audio/prerecorded.js"));
  ({ getRoleGreeting } = await import("../src/audio/greetings.js"));
  ({ describeKvBackend, probeKv } = await import("../src/services/kv.js"));
}

// ── SSM hydration ─────────────────────────────────────────────────────────────

/**
 * SSM suffix → env var. Mirrors the registry in scripts/ssm-params.sh and
 * the mappings in the two sync scripts. Order matters for the Anthropic
 * key: the canonical path is listed first and an already-set value is
 * never overwritten, so `ai/anthropic/api_key` wins over the legacy
 * `anthropic/api_key` when an account somehow has both.
 */
const SSM_ENV_MAP: Array<[suffix: string, envName: string]> = [
  ["twilio/account_sid", "TWILIO_ACCOUNT_SID"],
  ["twilio/auth_token", "TWILIO_AUTH_TOKEN"],
  ["twilio/phone_number", "TWILIO_PHONE_NUMBER"],
  ["twilio/messaging_service_sid", "TWILIO_MESSAGING_SERVICE_SID"],
  ["elevenlabs/api_key", "ELEVENLABS_API_KEY"],
  ["elevenlabs/voice_id_doug", "ELEVENLABS_VOICE_ID_DOUG"],
  ["ai/anthropic/api_key", "ANTHROPIC_API_KEY"],
  ["anthropic/api_key", "ANTHROPIC_API_KEY"],
  ["talk/outbound_api_key", "TALK_OUTBOUND_API_KEY"],
  ["talk/server_domain", "SERVER_DOMAIN"],
  ["talk/ws_domain", "WS_DOMAIN"],
  ["voice/inbound_phone_map", "INBOUND_PHONE_VOICE_MAP"],
  ["kv/url", "KV_URL"],
  ["kv/token", "KV_TOKEN"],
];

/**
 * Fill any UNSET env vars from SSM. Best-effort by design: no aws CLI, no
 * credentials, or a denied read all degrade to "use whatever the ambient
 * env has" rather than aborting — the preflight's job is to report what's
 * wrong, and failing to start is a worse report than a partial one.
 *
 * Returns the env var names it filled (never their values).
 */
function hydrateFromSsm(stage: string, region: string): string[] {
  const filled: string[] = [];
  let raw = "";
  try {
    // One paged call for the whole namespace beats 14 round trips.
    raw = execFileSync(
      "aws",
      [
        "ssm",
        "get-parameters-by-path",
        "--path",
        `/cotrackpro/${stage}`,
        "--recursive",
        "--with-decryption",
        "--region",
        region,
        "--query",
        "Parameters[].[Name,Value]",
        "--output",
        "text",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 },
    );
  } catch {
    return filled;
  }

  const bySuffix = new Map<string, string>();
  const prefix = `/cotrackpro/${stage}/`;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // `--output text` is TAB-separated; a value may itself contain tabs,
    // so split only on the FIRST tab.
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name = line.slice(0, tab);
    const value = line.slice(tab + 1).trim();
    if (!name.startsWith(prefix) || !value) continue;
    bySuffix.set(name.slice(prefix.length), value);
  }

  for (const [suffix, envName] of SSM_ENV_MAP) {
    if (process.env[envName]) continue; // ambient env / .env always wins
    const value = bySuffix.get(suffix);
    if (!value) continue;
    process.env[envName] = value;
    filled.push(envName);
  }
  return filled;
}

// ── Result plumbing ───────────────────────────────────────────────────────────

type Level = "pass" | "warn" | "fail";
interface Check {
  level: Level;
  label: string;
  detail?: string;
}

const checks: Check[] = [];
function pass(label: string, detail?: string): void {
  checks.push({ level: "pass", label, detail });
}
function warn(label: string, detail?: string): void {
  checks.push({ level: "warn", label, detail });
}
function fail(label: string, detail?: string): void {
  checks.push({ level: "fail", label, detail });
}

const ICON: Record<Level, string> = { pass: "✓", warn: "⚠", fail: "✗" };

function render(): void {
  let section = "";
  for (const c of checks) {
    const [head, ...rest] = c.label.split(" / ");
    if (head !== section) {
      section = head!;
      console.log(`\n${section}`);
    }
    const name = rest.join(" / ") || head!;
    console.log(`  ${ICON[c.level]} ${name}`);
    if (c.detail) console.log(`      ${c.detail}`);
  }
}

// ── Individual checks ─────────────────────────────────────────────────────────

/** GET a URL with a timeout, returning the status or a transport error. */
async function probe(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<{ ok: boolean; status?: number; error?: string; body?: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: body.slice(0, 400) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Verify the Twilio number's webhooks point at this deployment. A number
 * whose voiceUrl points somewhere else rings, and then does something
 * else entirely — the most confusing failure in the whole stack, so it's
 * checked first.
 */
async function checkTwilioNumber(phone: string): Promise<{
  found: boolean;
  smsViaService: boolean;
}> {
  const client = twilio(env.twilioAccountSid, env.twilioAuthToken);
  const expectedVoice = `https://${env.apiDomain}/call/incoming`;
  const expectedStatus = `https://${env.apiDomain}/call/status`;
  const expectedSms = `https://${env.apiDomain}/sms/incoming`;

  let matches;
  try {
    matches = await client.incomingPhoneNumbers.list({ phoneNumber: phone });
  } catch (err) {
    fail(
      "Twilio / number lookup",
      `Could not query Twilio: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { found: false, smsViaService: false };
  }

  if (!matches.length) {
    fail(
      "Twilio / number lookup",
      `${phone} is not on account ${env.twilioAccountSid}`,
    );
    return { found: false, smsViaService: false };
  }

  const n = matches[0]!;
  pass("Twilio / number found", `${n.phoneNumber} (${n.friendlyName || "no friendly name"})`);

  if (n.voiceUrl === expectedVoice) {
    pass("Twilio / voice webhook", expectedVoice);
  } else {
    fail(
      "Twilio / voice webhook",
      `is "${n.voiceUrl || "unset"}" — expected "${expectedVoice}". Run: npm run configure:twilio -- ${phone}`,
    );
  }

  if (n.voiceMethod !== "POST") {
    fail("Twilio / voice method", `is ${n.voiceMethod} — must be POST`);
  }

  if (n.statusCallback === expectedStatus) {
    pass("Twilio / status callback", expectedStatus);
  } else {
    warn(
      "Twilio / status callback",
      `is "${n.statusCallback || "unset"}" — expected "${expectedStatus}". Calls still work; completion records won't be finalized from Twilio's side.`,
    );
  }

  // SMS: the number-level smsUrl is only consulted when the number is NOT
  // attached to a Messaging Service. If it is, the service's inbound URL
  // wins — check that instead, otherwise a correct-looking smsUrl here is
  // a red herring.
  let smsViaService = false;
  if (env.twilioMessagingServiceSid) {
    try {
      const svc = await client.messaging.v1
        .services(env.twilioMessagingServiceSid)
        .fetch();
      const svcNumbers = await client.messaging.v1
        .services(env.twilioMessagingServiceSid)
        .phoneNumbers.list();
      const inService = svcNumbers.some((p) => p.phoneNumber === n.phoneNumber);
      if (inService) {
        smsViaService = true;
        pass(
          "Twilio / messaging service",
          `${svc.friendlyName} (${env.twilioMessagingServiceSid}) — number is attached`,
        );
        if (svc.inboundRequestUrl === expectedSms) {
          pass("Twilio / SMS webhook (service)", expectedSms);
        } else {
          fail(
            "Twilio / SMS webhook (service)",
            `service inbound URL is "${svc.inboundRequestUrl || "unset"}" — expected "${expectedSms}". The service overrides the number-level smsUrl, so inbound texts go nowhere until this is fixed.`,
          );
        }
      } else {
        warn(
          "Twilio / messaging service",
          `${phone} is NOT attached to ${env.twilioMessagingServiceSid}. Outbound SMS from this number won't be A2P-attributed.`,
        );
      }
    } catch (err) {
      warn(
        "Twilio / messaging service",
        `Could not fetch ${env.twilioMessagingServiceSid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    warn(
      "Twilio / messaging service",
      "TWILIO_MESSAGING_SERVICE_SID is unset. Fine for testing; production SMS sends refuse to run without it.",
    );
  }

  if (!smsViaService) {
    if (n.smsUrl === expectedSms) {
      pass("Twilio / SMS webhook (number)", expectedSms);
    } else {
      fail(
        "Twilio / SMS webhook (number)",
        `is "${n.smsUrl || "unset"}" — expected "${expectedSms}". Run: npm run configure:twilio -- ${phone}`,
      );
    }
  }

  return { found: true, smsViaService };
}

/** The API host has to be up, or Twilio gets no TwiML and the call dies. */
async function checkApiHost(): Promise<void> {
  const url = `https://${env.apiDomain}/health`;
  const res = await probe(url);
  if (res.ok) {
    pass("API host / health", url);
  } else {
    fail(
      "API host / health",
      res.error
        ? `${url} — ${res.error}`
        : `${url} returned ${res.status}. Twilio can't fetch TwiML; calls will fail immediately.`,
    );
  }
  // If /health itself was refused, the host is rejecting everything —
  // a 403 on the webhook below then says nothing about signature
  // validation, and reporting it as a pass would be a lie.
  const hostRefusing = res.status === 401 || res.status === 403;

  // The webhook itself should exist and reject unsigned requests (or
  // accept them when validation is off). A 404 here means the rewrite
  // isn't deployed.
  const hook = await probe(`https://${env.apiDomain}/call/incoming`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "From=%2B15555550100&To=%2B15555550101&CallSid=CApreflight",
  });
  if (hook.status === 404) {
    fail(
      "API host / call webhook",
      "POST /call/incoming returned 404 — the Vercel rewrite isn't live on this deployment.",
    );
  } else if (hook.status === 403 || hook.status === 401) {
    if (hostRefusing) {
      fail(
        "API host / call webhook",
        `POST /call/incoming returned ${hook.status}, but /health did too — the HOST is refusing every request (Vercel deployment protection, a WAF, or an egress proxy), not our signature check. Twilio will get the same refusal. Verify the deployment is public.`,
      );
    } else {
      pass(
        "API host / call webhook",
        `POST /call/incoming returned ${hook.status} while /health is reachable — signature validation is ON and rejecting unsigned requests (correct).`,
      );
    }
  } else if (hook.status === 200) {
    const streamsToWs = hook.body?.includes(`wss://${env.wsDomain}/call/stream`);
    if (streamsToWs) {
      pass(
        "API host / call webhook",
        `POST /call/incoming returned TwiML streaming to wss://${env.wsDomain}/call/stream`,
      );
    } else {
      warn(
        "API host / call webhook",
        `POST /call/incoming returned 200 but the TwiML doesn't point at wss://${env.wsDomain}/call/stream`,
      );
    }
    warn(
      "API host / signature validation",
      "An UNSIGNED POST was accepted. Set VALIDATE_TWILIO_SIGNATURE=true (it's forced on when NODE_ENV=production) before this number is public.",
    );
  } else {
    warn("API host / call webhook", `POST /call/incoming returned ${hook.status ?? hook.error}`);
  }
}

/**
 * The WebSocket host is what actually carries the conversation. Vercel
 * cannot serve it — if WS_DOMAIN still points at the Vercel host, the
 * call connects, the greeting never plays, and Twilio hangs up. This is
 * the single most common reason "the number doesn't talk to me".
 */
async function checkWsHost(): Promise<void> {
  if (env.wsDomain === env.apiDomain && /vercel\.app$/.test(env.wsDomain)) {
    fail(
      "WS host / domain",
      `WS_DOMAIN falls back to the Vercel host (${env.wsDomain}). Vercel can't serve Twilio's bidirectional Media Stream — inbound voice will connect and then go silent. Point WS_DOMAIN at the Fly/Fargate/Render host.`,
    );
    return;
  }
  pass("WS host / domain", `wss://${env.wsDomain}/call/stream`);

  const url = `wss://${env.wsDomain}/call/stream`;
  const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    let settled = false;
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve({ ok, detail });
    };
    const ws = new WebSocket(url, { handshakeTimeout: 8000 });
    ws.on("open", () => done(true, "handshake accepted"));
    ws.on("error", (err: Error) => done(false, err.message));
    setTimeout(() => done(false, "timed out after 10s"), 10_000);
  });

  if (result.ok) {
    pass("WS host / handshake", result.detail);
  } else {
    fail(
      "WS host / handshake",
      `${url} — ${result.detail}. The call will connect and hear nothing. Check that the WS process is deployed and healthy.`,
    );
  }

  const health = await probe(`https://${env.wsDomain}/health`);
  if (health.ok) pass("WS host / health", `https://${env.wsDomain}/health`);
  else warn("WS host / health", `https://${env.wsDomain}/health — ${health.error ?? health.status}`);
}

/**
 * Resolve the persona + voice this number will answer in, and confirm the
 * voice id is real. A typo'd voice id fails at TTS connect time, mid-call,
 * as silence — worth catching here instead.
 */
async function checkVoice(phone: string): Promise<void> {
  const entry = lookupInboundPhone(phone);
  const role = (entry?.role ?? "parent") as CoTrackProRole;
  const voiceId = entry?.voiceId ?? getVoiceId(role);

  if (entry) {
    pass(
      "Voice / persona binding",
      `INBOUND_PHONE_VOICE_MAP pins ${phone} → role "${role}", voice ${voiceId}`,
    );
  } else {
    warn(
      "Voice / persona binding",
      `${phone} has no INBOUND_PHONE_VOICE_MAP entry — falling back to role "parent" and its default voice ${voiceId}. To use YOUR ElevenLabs voice, set: INBOUND_PHONE_VOICE_MAP={"${phone}":{"voiceId":"<your-voice-id>","role":"parent"}}`,
    );
  }

  const res = await probe(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    headers: { "xi-api-key": env.elevenLabsApiKey },
  });
  if (res.ok) {
    let name = "";
    try {
      name = (JSON.parse(res.body ?? "{}") as { name?: string }).name ?? "";
    } catch {
      /* name is cosmetic */
    }
    pass("Voice / ElevenLabs voice id", `${voiceId}${name ? ` — "${name}"` : ""} resolves under this API key`);
  } else if (res.status === 401) {
    fail("Voice / ElevenLabs API key", "ELEVENLABS_API_KEY was rejected (401). TTS and STT will both fail.");
  } else if (res.status === 404) {
    fail(
      "Voice / ElevenLabs voice id",
      `${voiceId} does not exist on this account (404). The call will connect and then go silent when TTS fails.`,
    );
  } else {
    warn(
      "Voice / ElevenLabs voice id",
      `Could not verify ${voiceId} — ${res.error ?? `HTTP ${res.status}`}`,
    );
  }

  // Pre-rendered greeting audio is a cost/latency optimization keyed by
  // (role, voiceId). A miss is not a failure — the greeting is spoken via
  // live TTS in the same voice — but it's worth knowing about.
  const key = greetingKey(role, voiceId);
  if (GREETINGS_ULAW[key]?.length) {
    pass("Voice / greeting audio cache", `pre-rendered for ${key}`);
  } else {
    warn(
      "Voice / greeting audio cache",
      `no pre-rendered audio for ${key} — the greeting will be spoken via live TTS (same voice, ~300ms slower, billed per char). Run: npm run generate-audio`,
    );
  }

  console.log(`\n  The greeting this number opens with:\n    "${getRoleGreeting(role)}"`);
}

/** Confirm the conversational brains are configured on both channels. */
async function checkConversational(): Promise<void> {
  if (env.anthropicApiKey) {
    pass("Conversation / Anthropic", `model ${env.anthropicModel}`);
  } else {
    fail("Conversation / Anthropic", "ANTHROPIC_API_KEY is unset — neither voice nor SMS can reply.");
  }

  if (env.smsAiEnabled) {
    pass(
      "Conversation / SMS",
      `conversational replies ON (cap ${env.smsReplyMaxChars} chars, ${env.smsAiRateLimitPerMin}/min per sender, ${env.smsThreadTtlSeconds}s thread memory)`,
    );
  } else {
    warn(
      "Conversation / SMS",
      "SMS_AI_ENABLED=false — inbound texts fall back to forwarding the first word to the hub's keyword router.",
    );
  }

  // Ask the KV module which backend it ACTUALLY resolved, rather than
  // re-deriving the rule here. The previous version of this check did
  // re-derive it and got it wrong twice over: it missed KV_BACKEND=upstash
  // with a missing token (which silently falls back to memory) and it
  // missed a typo'd KV_BACKEND (same silent fallback), reporting a pass on
  // a deployment that was really running in-process.
  const info = describeKvBackend();
  if (!info.durable) {
    const because =
      info.reason === "fallback-missing-credentials" ||
      info.reason === "fallback-unknown-backend"
        ? `KV config is BROKEN and fell back to memory — ${info.detail}`
        : `KV backend is in-memory (${info.detail})`;
    fail(
      "Durable state / KV backend",
      `${because}. On Vercel each request may hit a different instance, so STOP opt-outs don't persist, dedupeKey doesn't dedupe, outbound voice lines are lost between the call and Twilio's audio fetch, and SMS threads lose context. Set KV_URL/KV_TOKEN (Upstash) or KV_BACKEND=dynamo.`,
    );
    return;
  }

  pass("Durable state / KV backend", `${info.backend} — ${info.detail}`);

  // Configured is not the same as working. DynamoKv in particular builds
  // its client without resolving credentials, so a missing IAM key or an
  // absent table looks healthy until the first real write — and every KV
  // caller fails open, so that write is swallowed rather than surfaced.
  const probe = await probeKv();
  if (probe.ok) {
    pass(
      "Durable state / KV round-trip",
      `set → get → delete against ${probe.backend} in ${probe.roundTripMs}ms`,
    );
  } else {
    fail(
      "Durable state / KV round-trip",
      `${probe.backend} is configured but NOT working: ${probe.error}. Every KV caller fails open, so this produces no failed requests — just silently missing state.`,
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const USAGE = `Usage: tsx scripts/check-line.ts <+E164> [options]

  --stage <prod|test>     SSM namespace to hydrate from (default: prod)
  --region <aws-region>   default: $AWS_REGION or us-east-1
  --api-domain <host>     override API_DOMAIN (no scheme)
  --ws-domain <host>      override WS_DOMAIN (no scheme)
  --no-ssm                don't hydrate from SSM; use ambient env/.env only

Example:
  npm run check:line -- +13143948500 --api-domain talk.cotrackpro.com`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let phone = "";
  let stage = "prod";
  let region = process.env.AWS_REGION || "us-east-1";
  let useSsm = true;
  let apiDomainOverride = "";
  let wsDomainOverride = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--stage": stage = argv[++i] ?? ""; break;
      case "--region": region = argv[++i] ?? ""; break;
      case "--api-domain": apiDomainOverride = argv[++i] ?? ""; break;
      case "--ws-domain": wsDomainOverride = argv[++i] ?? ""; break;
      case "--no-ssm": useSsm = false; break;
      case "-h": case "--help": console.log(USAGE); process.exit(0); break;
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown option '${a}'\n\n${USAGE}`);
          process.exit(2);
        }
        phone = a;
    }
  }

  if (!phone) {
    console.error(USAGE);
    process.exit(2);
  }
  if (stage !== "prod" && stage !== "test") {
    console.error(`--stage must be 'prod' or 'test' (got '${stage}')`);
    process.exit(2);
  }

  // CLI overrides beat everything, including SSM (hydration never
  // overwrites an already-set var).
  if (apiDomainOverride) process.env.API_DOMAIN = apiDomainOverride;
  if (wsDomainOverride) process.env.WS_DOMAIN = wsDomainOverride;

  if (useSsm) {
    const filled = hydrateFromSsm(stage, region);
    if (filled.length) {
      console.log(
        `Hydrated ${filled.length} value(s) from SSM /cotrackpro/${stage}: ${filled.join(", ")}`,
      );
    } else {
      console.log(
        `No values hydrated from SSM (aws CLI missing, no credentials, or nothing unset).`,
      );
    }
  }

  // env.ts requires an API domain and has no sensible default off-Vercel.
  // Fail here with the fix rather than letting its import throw a stack
  // trace at the user.
  if (!process.env.API_DOMAIN && !process.env.SERVER_DOMAIN) {
    console.error(
      `\nNo API domain resolved.\n` +
        `  Pass one:        npm run check:line -- ${phone} --api-domain cotrackpro-talk.vercel.app\n` +
        `  Or store it:     aws ssm put-parameter --name /cotrackpro/${stage}/talk/server_domain \\\n` +
        `                     --type String --value <your-vercel-host>\n` +
        `  (On Vercel itself this auto-detects; it's only unset when running locally.)`,
    );
    process.exit(2);
  }

  // env.ts validates at import and throws on the first missing required
  // var. Catch it: a preflight tool that dies with a stack trace before
  // checking anything is worse than useless, and the thing the operator
  // needs to know is which var and where it comes from.
  try {
    await loadApp();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${msg}`);
    console.error(
      useSsm
        ? `\nSSM hydration didn't supply it. Check that the parameter exists:\n` +
            `  ./scripts/ssm-params.sh check --stage ${stage}\n` +
            `and that your AWS credentials can read /cotrackpro/${stage}/* ` +
            `(aws sts get-caller-identity).`
        : `\nYou passed --no-ssm, so only the ambient env and .env were used. ` +
            `Drop --no-ssm to hydrate from /cotrackpro/${stage}/*.`,
    );
    process.exit(2);
  }

  console.log(`\nPreflight for ${phone}`);
  console.log(`  API host: https://${env.apiDomain}`);
  console.log(`  WS host:  wss://${env.wsDomain}`);

  const { found } = await checkTwilioNumber(phone);
  await checkApiHost();
  await checkWsHost();
  await checkVoice(phone);
  await checkConversational();

  render();

  const failures = checks.filter((c) => c.level === "fail").length;
  const warnings = checks.filter((c) => c.level === "warn").length;

  console.log(
    `\n${failures === 0 ? "READY" : "NOT READY"} — ${checks.filter((c) => c.level === "pass").length} passed, ${warnings} warning(s), ${failures} failure(s)`,
  );

  if (failures === 0 && found) {
    console.log(`\nTry it:`);
    console.log(`  Call ${phone} — you should hear the greeting above, then just talk.`);
    console.log(`  Text ${phone} — try "my ex showed up 2 hours late again and the kids were upset".`);
    console.log(`  Then send a follow-up like "what should I write down?" to check thread memory.`);
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
