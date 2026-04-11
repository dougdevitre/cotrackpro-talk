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

  // ElevenLabs
  elevenLabsApiKey: required("ELEVENLABS_API_KEY"),
  elevenLabsModelId: optional("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),

  // Anthropic
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  anthropicModel: optional("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),

  // CoTrackPro MCP
  cotrackproMcpUrl: optional("COTRACKPRO_MCP_URL", "https://mcp.cotrackpro.com/sse"),

  // Outbound API auth (set to require Bearer token on /call/outbound)
  outboundApiKey: process.env.OUTBOUND_API_KEY || "",

  // Twilio webhook signature validation (set to "true" to enable)
  validateTwilioSignature: optional("VALIDATE_TWILIO_SIGNATURE", "false"),

  // DynamoDB
  dynamoTableName: optional("DYNAMO_TABLE_NAME", "cotrackpro-calls"),
  dynamoRegion: optional("AWS_REGION", "us-east-1"),
  // Set to "true" to enable DynamoDB persistence (disabled by default so
  // the app runs without AWS credentials during local development)
  dynamoEnabled: optional("DYNAMO_ENABLED", "false"),
  // Retention (days) for call records before DynamoDB TTL auto-deletes them
  recordsTtlDays: parseFloat(optional("RECORDS_TTL_DAYS", "365")),

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
} as const;
