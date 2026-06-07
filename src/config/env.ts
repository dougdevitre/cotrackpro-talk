/**
 * config/env.ts — Validated environment configuration
 *
 * All secrets come from env vars (SSM SecureString in prod).
 * Fails fast on missing required values.
 */

import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

// Domain resolution for hybrid deployments
// ────────────────────────────────────────
// Two deployment shapes are supported:
//
//  1. Single host (AWS Fargate, Fly, Render, etc.)
//     Set SERVER_DOMAIN=voice.example.com. Both the HTTP API and the
//     Twilio Media Stream WebSocket are served from the same domain.
//
//  2. Hybrid: Vercel for HTTP + long-running host for the WebSocket
//     Set API_DOMAIN=api.example.com (Vercel) and
//         WS_DOMAIN=ws.example.com  (Fargate/Fly/Render/etc).
//     The TwiML returned by the API must point <Stream url> at WS_DOMAIN,
//     which is what makes this split work — Vercel's serverless runtime
//     can't host Twilio's long-lived bidirectional media stream.
//
// Either form is valid. If only SERVER_DOMAIN is set, API and WS both
// resolve to it. If API_DOMAIN/WS_DOMAIN are set, they override.
const _serverDomain = process.env.SERVER_DOMAIN || "";
const _apiDomain = process.env.API_DOMAIN || _serverDomain;
const _wsDomain = process.env.WS_DOMAIN || _serverDomain;

if (!_apiDomain) {
  throw new Error(
    "Missing required env var: set API_DOMAIN (Vercel hybrid) or SERVER_DOMAIN (single host)",
  );
}
if (!_wsDomain) {
  throw new Error(
    "Missing required env var: set WS_DOMAIN (Vercel hybrid) or SERVER_DOMAIN (single host)",
  );
}

export const env = {
  // Server
  port: parseInt(optional("PORT", "8080"), 10),
  // Legacy single-host domain. Still exposed for callers that haven't
  // migrated to the API/WS split; resolves to apiDomain when unset.
  serverDomain: _serverDomain || _apiDomain,
  // Domain that serves HTTP routes (TwiML webhook, outbound, records,
  // health). Hosted on Vercel in the hybrid deployment.
  apiDomain: _apiDomain,
  // Domain that serves the Twilio Media Stream WebSocket (/call/stream).
  // Must be a long-running host — NOT a serverless function.
  wsDomain: _wsDomain,
  nodeEnv: optional("NODE_ENV", "development"),
  logLevel: optional("LOG_LEVEL", "info"),

  // Twilio
  twilioAccountSid: required("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: required("TWILIO_AUTH_TOKEN"),
  twilioPhoneNumber: required("TWILIO_PHONE_NUMBER"),
  // A2P 10DLC Messaging Service SID. Outbound SMS MUST be sent through
  // this (not a bare from-number) so every message is attributed to the
  // approved A2P brand/campaign. Mirrored from SSM
  // /cotrackpro/<stage>/twilio/messaging_service_sid. When unset, SMS
  // sends fall back to the from-number — allowed for local/test only;
  // src/core/sms.ts fails closed on a missing service SID in production.
  twilioMessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || "",

  // ElevenLabs
  elevenLabsApiKey: required("ELEVENLABS_API_KEY"),
  elevenLabsModelId: optional("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
  // Default voice for the browser TTS proxy (/api/ai/tts). Separate
  // from the telephony voice because the in-app UI can afford a
  // warmer, longer-latency voice than a phone call needs. Set to any
  // valid ElevenLabs voice_id.
  elevenLabsTtsVoiceId: optional("ELEVENLABS_TTS_VOICE_ID", "2ydcbtd5sJZRYFMNgMVZ"),
  // Named ElevenLabs voice for the "Doug" persona. Mirrored from SSM
  // /cotrackpro/<stage>/elevenlabs/voice_id_doug. Optional — callers that
  // need it read env.elevenLabsVoiceIdDoug; empty when not provisioned.
  elevenLabsVoiceIdDoug: process.env.ELEVENLABS_VOICE_ID_DOUG || "",
  // Output format for /api/ai/tts. Browsers accept mp3 everywhere; the
  // audio/ulaw variants are telephony-only.
  elevenLabsTtsOutputFormat: optional("ELEVENLABS_TTS_OUTPUT_FORMAT", "mp3_44100_128"),
  // Hard cap on characters per /api/ai/tts request. ElevenLabs bills
  // per char; capping here protects against cost blow-ups from a
  // compromised browser.
  ttsMaxCharsPerRequest: parseInt(optional("TTS_MAX_CHARS_PER_REQUEST", "1500"), 10),

  // Anthropic
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  anthropicModel: optional("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
  // Default model for the sub-app proxy (/api/ai/complete) when a
  // caller doesn't pass `model` explicitly. Separate from anthropicModel
  // because the voice pipeline and the sub-apps have different
  // latency/quality tradeoffs: phone calls want Sonnet for TTFB, sub-app
  // UIs want Opus for reasoning quality.
  anthropicSubappModel: optional("ANTHROPIC_SUBAPP_MODEL", "claude-opus-4-7"),

  // CoTrackPro MCP
  cotrackproMcpUrl: optional("COTRACKPRO_MCP_URL", "https://mcp.cotrackpro.com/sse"),

  // Clerk (federated auth from CoTrackPro sub-apps)
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || "",
  clerkSecretKey: process.env.CLERK_SECRET_KEY || "",

  // Outbound API auth (set to require Bearer token on /call/outbound).
  //
  // This SAME token is the shared hub↔talk bearer (SSM
  // /cotrackpro/<stage>/talk/outbound_api_key). The talk edge PRESENTS
  // it on calls TO the hub (resolve-phone, send-auth-link) and VERIFIES
  // it (constant-time) on calls FROM the hub (/api/sms/send,
  // /call/outbound). One secret, both directions — see src/services/hub.ts
  // and src/core/sms.ts.
  //
  // Canonical Vercel name is TALK_OUTBOUND_API_KEY (what
  // scripts/sync-ssm-to-vercel.sh mirrors the SSM value into). The legacy
  // OUTBOUND_API_KEY name is still honored as a fallback so existing
  // deploys keep working through the rename.
  outboundApiKey:
    process.env.TALK_OUTBOUND_API_KEY || process.env.OUTBOUND_API_KEY || "",

  // ── CoTrackPro hub (identity / OTP / token minting) ──────────────────
  // Base URL of the hub's Lambda Function URL / custom domain, per stage.
  // The talk edge calls {hubBaseUrl}/internal/v1/resolve-phone and
  // .../send-auth-link to recognize callers and text unlinked callers a
  // one-time sign-in link. Empty disables hub integration (the inbound
  // loop then treats every caller as anonymous — crisis resources +
  // anonymous help still work). No trailing slash.
  hubBaseUrl: (process.env.HUB_BASE_URL || "").replace(/\/+$/, ""),
  // Timeout (ms) on each hub HTTP call. Kept short so a slow/unreachable
  // hub can't stall Twilio's inbound webhook (Twilio drops the call if
  // the webhook doesn't return promptly).
  hubTimeoutMs: parseInt(optional("HUB_TIMEOUT_MS", "4000"), 10),

  // ── SMS send (hub → talk: POST /api/sms/send) ────────────────────────
  // Fixed-window rate limit on the inbound SMS-send endpoint. The hub
  // composes the body and authenticates with the shared bearer, but we
  // still cap throughput as defense-in-depth against a leaked key
  // amplifying into Twilio SMS spend.
  smsRateLimitPerMin: parseInt(optional("SMS_RATE_LIMIT_PER_MIN", "30"), 10),
  smsRateLimitPerHour: parseInt(optional("SMS_RATE_LIMIT_PER_HOUR", "500"), 10),

  // Twilio webhook signature validation (set to "true" to enable)
  validateTwilioSignature: optional("VALIDATE_TWILIO_SIGNATURE", "false"),

  // DynamoDB
  dynamoTableName: optional("DYNAMO_TABLE_NAME", "cotrackpro-calls"),
  dynamoRegion: optional("AWS_REGION", "us-east-1"),
  // Set to "true" to enable DynamoDB persistence (disabled by default so
  // the app runs without AWS credentials during local development)
  dynamoEnabled: optional("DYNAMO_ENABLED", "false"),
  // Retention (days) for call records before DynamoDB TTL auto-deletes them.
  // Guarded against malformed input — `parseFloat("abc")` returns NaN, which
  // would propagate into a TTL calc that silently writes garbage timestamps.
  recordsTtlDays: (() => {
    const n = parseFloat(optional("RECORDS_TTL_DAYS", "365"));
    return Number.isFinite(n) && n > 0 ? n : 365;
  })(),

  // Pricing (USD per million tokens / per 1K chars / per minute) — used by
  // the cost estimator. Override via env as prices change.
  // Defaults reflect Claude Sonnet 4 and ElevenLabs Flash v2.5 at time of writing.
  claudeInputPricePerMTok: parseFloat(optional("CLAUDE_INPUT_PRICE_PER_MTOK", "3.00")),
  claudeOutputPricePerMTok: parseFloat(optional("CLAUDE_OUTPUT_PRICE_PER_MTOK", "15.00")),
  claudeCacheWritePricePerMTok: parseFloat(optional("CLAUDE_CACHE_WRITE_PRICE_PER_MTOK", "3.75")),
  claudeCacheReadPricePerMTok: parseFloat(optional("CLAUDE_CACHE_READ_PRICE_PER_MTOK", "0.30")),
  elevenLabsTtsPricePer1KChars: parseFloat(optional("ELEVENLABS_TTS_PRICE_PER_1K_CHARS", "0.10")),
  elevenLabsSttPricePerMin: parseFloat(optional("ELEVENLABS_STT_PRICE_PER_MIN", "0.008")),

  // Voice map override (JSON string)
  voiceMapOverride: process.env.VOICE_MAP || "",

  // Per-phone-number override for inbound calls. JSON object keyed by
  // E.164 number → { voiceId, role }. Consulted by /call/incoming so
  // a single Twilio number can be pinned to a specific voice + persona
  // without a code change. Empty string disables the lookup (falls
  // back to the role query param + getVoiceId(role) default).
  // Example: {"+13143948500":{"voiceId":"2ydcbtd5sJZRYFMNgMVZ","role":"parent"}}
  inboundPhoneVoiceMap: process.env.INBOUND_PHONE_VOICE_MAP || "",

  // ── KV store (cross-instance shared state: rate limits, etc.) ────────
  // Backend: "auto" (default — uses upstash if KV_URL/KV_TOKEN set, else
  // memory), "memory", or "upstash".
  kvBackend: optional("KV_BACKEND", "auto") as "auto" | "memory" | "upstash",
  // Upstash Redis REST URL + Bearer token. Vercel KV is API-compatible;
  // set these to Vercel KV's values to use that instead.
  kvUrl: process.env.KV_URL || "",
  kvToken: process.env.KV_TOKEN || "",

  // ── Rate limits ──────────────────────────────────────────────────────
  // Fixed-window rate limit on POST /call/outbound. Protects against
  // runaway bills if OUTBOUND_API_KEY is ever leaked.
  outboundRateLimitPerMin: parseInt(
    optional("OUTBOUND_RATE_LIMIT_PER_MIN", "30"),
    10,
  ),
  outboundRateLimitPerHour: parseInt(
    optional("OUTBOUND_RATE_LIMIT_PER_HOUR", "500"),
    10,
  ),
  // Fixed-window rate limit on /records/*. Prevents a leaked API key
  // from amplifying into unbounded DynamoDB scan cost (audit E-1).
  // Defaults are looser than /call/outbound because dashboard
  // pagination is chattier but less expensive per request.
  recordsRateLimitPerMin: parseInt(
    optional("RECORDS_RATE_LIMIT_PER_MIN", "120"),
    10,
  ),
  recordsRateLimitPerHour: parseInt(
    optional("RECORDS_RATE_LIMIT_PER_HOUR", "2000"),
    10,
  ),
  // Per-user budget on POST /api/ai/complete — shared across every sub-app
  // a Clerk user touches, so one compromised sub-app can't amplify abuse.
  aiRateLimitPerMin: parseInt(optional("AI_RATE_LIMIT_PER_MIN", "20"), 10),
  aiRateLimitPerHour: parseInt(optional("AI_RATE_LIMIT_PER_HOUR", "300"), 10),
  // Per-user budget on POST /api/ai/tts. ElevenLabs charges per char
  // and each request can be up to TTS_MAX_CHARS_PER_REQUEST, so this
  // budget multiplied by that cap is the worst-case spend per user
  // per window. Keep tight.
  ttsRateLimitPerMin: parseInt(optional("TTS_RATE_LIMIT_PER_MIN", "10"), 10),
  ttsRateLimitPerHour: parseInt(optional("TTS_RATE_LIMIT_PER_HOUR", "100"), 10),

  // ── Concurrent-call cap (audit E-2) ─────────────────────────────────
  // Hard ceiling on simultaneous WS sessions on a single WS host. New
  // sessions beyond this are rejected BEFORE any downstream STT / Claude
  // / TTS resource is allocated, so an attacker that opens 100k WS
  // connections can't OOM the host. The Fastify WS route returns a
  // concise close frame and Twilio retries or hangs up.
  maxConcurrentSessions: parseInt(
    optional("MAX_CONCURRENT_SESSIONS", "200"),
    10,
  ),

  // ── DynamoDB retry budget (audit E-4) ───────────────────────────────
  // Max retries the AWS SDK attempts on transient errors before a
  // write fails permanently. Increase if you see throttling under
  // load; decrease if retry latency during DynamoDB outages is
  // hurting call quality more than missing records would.
  dynamoMaxRetries: parseInt(optional("DYNAMO_MAX_RETRIES", "3"), 10),

  // ── External-service timeouts (audit E-5) ───────────────────────────
  // Explicit timeouts on the audio hot path so a slow upstream doesn't
  // deadlock a call until the 2-hour max-duration reaper kicks in.
  // Values in milliseconds.
  anthropicStreamTimeoutMs: parseInt(
    optional("ANTHROPIC_STREAM_TIMEOUT_MS", "45000"),
    10,
  ),
  elevenLabsConnectTimeoutMs: parseInt(
    optional("ELEVENLABS_CONNECT_TIMEOUT_MS", "10000"),
    10,
  ),

  // ── Phone number allow-list (C-1 in the code review) ────────────────
  // Comma-separated ISO-3166 country codes the /call/outbound endpoint
  // is allowed to dial. Defaults to "US,CA" because that matches the
  // operational target today. Set to "*" to disable the check entirely
  // (not recommended — removes bill-fraud protection).
  outboundAllowedCountryCodes: optional(
    "OUTBOUND_ALLOWED_COUNTRY_CODES",
    "US,CA",
  ),

  // ── Vercel Cron ──────────────────────────────────────────────────────
  // Shared secret Vercel Cron sends as Bearer token. Required in prod;
  // leave unset locally to skip auth when testing the cron handler.
  cronSecret: process.env.CRON_SECRET || "",

  // ── Admin dashboard ──────────────────────────────────────────────────
  // Optional separate API key for the dashboard. If unset, the dashboard
  // reuses OUTBOUND_API_KEY (same token it already needs for /records).
  dashboardApiKey: process.env.DASHBOARD_API_KEY || "",
} as const;
