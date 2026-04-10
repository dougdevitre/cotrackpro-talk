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

export const env = {
  // Server
  port: parseInt(optional("PORT", "8080"), 10),
  serverDomain: required("SERVER_DOMAIN"),
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
