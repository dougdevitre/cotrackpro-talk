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
 *   npx tsx scripts/check-line.ts +13143948500
 *
 * Exits 0 when the line is callable, 1 when any REQUIRED check fails.
 * Warnings (⚠) never fail the run — they flag things that degrade
 * quality or cost, not things that break the call.
 *
 * REQUIREMENTS:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ELEVENLABS_API_KEY,
 *   API_DOMAIN (or SERVER_DOMAIN), WS_DOMAIN (or SERVER_DOMAIN)
 */

import "dotenv/config";
import twilio from "twilio";
import WebSocket from "ws";
import { env } from "../src/config/env.js";
import { getVoiceId } from "../src/config/voices.js";
import { lookupInboundPhone } from "../src/config/inboundPhoneMap.js";
import { GREETINGS_ULAW, greetingKey } from "../src/audio/prerecorded.js";
import { getRoleGreeting } from "../src/audio/greetings.js";
import type { CoTrackProRole } from "../src/types/index.js";

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
  } else if (hook.status === 403) {
    pass(
      "API host / call webhook",
      "POST /call/incoming returned 403 — signature validation is ON and rejecting unsigned requests (correct).",
    );
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
function checkConversational(): void {
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

  if (env.kvBackend === "memory" || (!env.kvUrl && env.kvBackend === "auto")) {
    warn(
      "Conversation / SMS thread memory",
      "KV backend is in-memory. On Vercel each request may hit a different instance, so SMS threads will lose context between messages. Set KV_URL/KV_TOKEN (Upstash/Vercel KV) or KV_BACKEND=dynamo.",
    );
  } else {
    pass("Conversation / SMS thread memory", `KV backend: ${env.kvBackend}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const phone = process.argv[2];
  if (!phone) {
    console.error("Usage: tsx scripts/check-line.ts <+E164>   (e.g. +13143948500)");
    process.exit(2);
  }

  console.log(`Preflight for ${phone}`);
  console.log(`  API host: https://${env.apiDomain}`);
  console.log(`  WS host:  wss://${env.wsDomain}`);

  const { found } = await checkTwilioNumber(phone);
  await checkApiHost();
  await checkWsHost();
  await checkVoice(phone);
  checkConversational();

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
