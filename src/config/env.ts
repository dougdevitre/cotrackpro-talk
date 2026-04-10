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

  // Voice map override (JSON string)
  voiceMapOverride: process.env.VOICE_MAP || "",
} as const;
