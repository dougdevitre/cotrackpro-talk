/**
 * CoTrackPro Voice Center — Shared Types
 */

// ---------------------------------------------------------------------------
// Twilio WebSocket message types
// ---------------------------------------------------------------------------

export interface TwilioConnectedMessage {
  event: "connected";
  protocol: string;
  version: string;
}

export interface TwilioStartMessage {
  event: "start";
  sequenceNumber: string;
  start: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    customParameters: Record<string, string>;
    mediaFormat: {
      encoding: string; // "audio/x-mulaw"
      sampleRate: number; // 8000
      channels: number; // 1
    };
  };
  streamSid: string;
}

export interface TwilioMediaMessage {
  event: "media";
  sequenceNumber: string;
  media: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string; // base64-encoded mulaw audio
  };
  streamSid: string;
}

export interface TwilioStopMessage {
  event: "stop";
  sequenceNumber: string;
  streamSid: string;
  stop: {
    accountSid: string;
    callSid: string;
  };
}

export interface TwilioMarkMessage {
  event: "mark";
  sequenceNumber: string;
  streamSid: string;
  mark: {
    name: string;
  };
}

export type TwilioInboundMessage =
  | TwilioConnectedMessage
  | TwilioStartMessage
  | TwilioMediaMessage
  | TwilioStopMessage
  | TwilioMarkMessage;

// ---------------------------------------------------------------------------
// Twilio outbound messages (server → Twilio)
// ---------------------------------------------------------------------------

export interface TwilioOutboundMedia {
  event: "media";
  streamSid: string;
  media: {
    payload: string; // base64-encoded mulaw audio
  };
}

export interface TwilioOutboundMark {
  event: "mark";
  streamSid: string;
  mark: {
    name: string;
  };
}

export interface TwilioOutboundClear {
  event: "clear";
  streamSid: string;
}

// ---------------------------------------------------------------------------
// ElevenLabs WebSocket types
// ---------------------------------------------------------------------------

export interface ElevenLabsBOS {
  text: " ";
  voice_settings?: {
    stability: number;
    similarity_boost: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
  xi_api_key: string;
  generation_config?: {
    chunk_length_schedule?: number[];
  };
}

export interface ElevenLabsTextInput {
  text: string;
  try_trigger_generation?: boolean;
  flush?: boolean;
}

export interface ElevenLabsEOS {
  text: "";
}

export interface ElevenLabsAudioResponse {
  audio?: string; // base64-encoded audio chunk
  isFinal?: boolean;
  normalizedAlignment?: {
    char_start_times_ms: number[];
    chars_durations_ms: number[];
    chars: string[];
  };
}

// ---------------------------------------------------------------------------
// Call session state
// ---------------------------------------------------------------------------

export type CoTrackProRole =
  | "parent"
  | "attorney"
  | "gal"
  | "judge"
  | "therapist"
  | "school_counselor"
  | "law_enforcement"
  | "mediator"
  | "advocate"
  | "kid_teen"
  | "social_worker"
  | "cps"
  | "evaluator";

export interface CallSession {
  callSid: string;
  streamSid: string;
  role: CoTrackProRole;
  voiceId: string;
  conversationHistory: ConversationTurn[];
  isProcessing: boolean;
  audioBuffer: Buffer[];
  silenceStartMs: number | null;
  lastActivityMs: number;
  mcpSessionId?: string;
}

/**
 * Content can be a plain string or structured Anthropic content blocks.
 * Structured blocks are needed for tool_use (assistant) and tool_result (user)
 * messages so the Anthropic API receives a valid message chain.
 */
export type TurnContent = string | Array<Record<string, unknown>>;

export interface ConversationTurn {
  role: "user" | "assistant";
  content: TurnContent;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Voice map config
// ---------------------------------------------------------------------------

export type VoiceMap = Partial<Record<CoTrackProRole, string>>;

// ---------------------------------------------------------------------------
// Anthropic + MCP tool call types
// ---------------------------------------------------------------------------

export interface MCPToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface MCPToolResult {
  tool_use_id: string;
  content: string;
}
