/**
 * services/anthropic.ts — Anthropic Claude conversation service
 *
 * Streams text responses from Claude using the CoTrackPro system prompt.
 * Emits text chunks as they arrive so the caller can pipe them into
 * the ElevenLabs TTS WebSocket for real-time speech synthesis.
 *
 * MCP INTEGRATION NOTE:
 * The Anthropic SDK's native MCP support (mcp_servers param) is currently
 * limited to the API's server-side connector. For this voice center we
 * embed the CoTrackPro tool schemas directly and call the MCP server
 * ourselves when tool_use blocks are returned. This gives us full control
 * over latency and error handling in the voice pipeline.
 */

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";
import type { CallSession, ConversationTurn } from "../types/index.js";
import { logger } from "../utils/logger.js";

const client = new Anthropic({ apiKey: env.anthropicApiKey });

// ── CoTrackPro system prompt ────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a CoTrackPro voice assistant — a child-centered, trauma-informed \
documentation and safety platform. You are speaking on a live phone call.

CORE RULES:
- Speak in short, natural sentences suitable for voice. No markdown, no bullet points.
- Be calm, professional, empathetic. Practical over poetic.
- Court-neutral: factual, source-attributed, objective. No opinions or accusations.
- Educational framing only — legal and clinical content is informational.
  Append: "For legal advice, consult a licensed attorney."
- Never fabricate statutes, case citations, or clinical standards.
- If the caller mentions harm, danger, abuse, or emergency — immediately ask:
  "Is anyone in immediate physical danger right now?" and route to safety.
- Protect PII: never read back full names, addresses, or case numbers unprompted.
- Keep responses under 3 sentences unless the caller asks for more detail.
- When the caller asks to document something, confirm what you'll record,
  then summarize it back to them for confirmation.
- You can help with: incident documentation, safety plans, court preparation,
  message de-escalation, evidence timelines, and general co-parenting guidance.
- At the start of the call, greet the caller warmly, identify yourself as the
  CoTrackPro assistant, and ask how you can help today.

VOICE PERSONA:
You are speaking as the voice persona assigned to this caller's role.
Adapt your language complexity to the caller's role tier:
- Professional (attorney, GAL, judge): concise legal/clinical language
- Support professional (therapist, social worker): standard, clear language
- Parent / self-represented: plain language, explain terms simply
- Kid/Teen: age-appropriate, simplified, friendly

IMPORTANT: You are on a phone call. Do not use any formatting — no asterisks,
no numbered lists, no headers. Speak naturally as if in conversation.`;

// ── MCP tool definitions (subset for voice interactions) ────────────────────
const COTRACKPRO_TOOLS: Anthropic.Tool[] = [
  {
    name: "start_session",
    description:
      "Initialize a CoTrackPro session with role, trigger text, and risk level. Returns a sessionId and workstream routing.",
    input_schema: {
      type: "object" as const,
      properties: {
        role: {
          type: "string",
          description: "CoTrackPro role: parent, attorney, gal, judge, therapist, etc.",
        },
        trigger: {
          type: "string",
          description: "Free text describing what brought the caller in.",
        },
      },
      required: ["role", "trigger"],
    },
  },
  {
    name: "check_safety",
    description:
      "Run a safety triage check. Use when caller mentions harm, danger, abuse, weapons, or emergency.",
    input_schema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        context: {
          type: "string",
          description: "The caller's statement that triggered the safety check.",
        },
      },
      required: ["sessionId", "context"],
    },
  },
  {
    name: "rewrite_message",
    description:
      "De-escalate and neutralize a co-parenting message. Returns a rewritten version with a neutrality score.",
    input_schema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        original_message: { type: "string" },
      },
      required: ["sessionId", "original_message"],
    },
  },
  {
    name: "generate_artifact",
    description:
      "Generate a role-appropriate documentation artifact (incident log, safety plan, timeline, etc.).",
    input_schema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        artifact_type: { type: "string" },
        data: {
          type: "object",
          description: "Key-value data collected from the caller.",
        },
      },
      required: ["sessionId", "artifact_type"],
    },
  },
];

// ── Build Anthropic messages from conversation history ──────────────────────
function buildMessages(
  session: CallSession,
): Anthropic.MessageParam[] {
  return session.conversationHistory.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));
}

// ── Stream a response from Claude ───────────────────────────────────────────

export interface StreamCallbacks {
  /** Called with each text delta as it arrives */
  onTextDelta: (text: string) => void;
  /** Called when the full response is complete */
  onComplete: (fullText: string) => void;
  /** Called if Claude requests a tool call (MCP) */
  onToolUse?: (toolName: string, toolInput: Record<string, unknown>, toolUseId: string) => void;
  /** Called on error */
  onError: (err: Error) => void;
}

export async function streamResponse(
  session: CallSession,
  callbacks: StreamCallbacks,
): Promise<void> {
  const log = logger.child({ callSid: session.callSid });

  try {
    const stream = client.messages.stream({
      model: env.anthropicModel,
      max_tokens: 512, // Keep voice responses concise
      system: SYSTEM_PROMPT,
      messages: buildMessages(session),
      tools: COTRACKPRO_TOOLS,
    });

    let fullText = "";

    stream.on("text", (text) => {
      fullText += text;
      callbacks.onTextDelta(text);
    });

    stream.on("contentBlock", (block) => {
      if (block.type === "tool_use" && callbacks.onToolUse) {
        callbacks.onToolUse(
          block.name,
          block.input as Record<string, unknown>,
          block.id,
        );
      }
    });

    const finalMessage = await stream.finalMessage();

    // Check for tool_use in stop_reason
    if (finalMessage.stop_reason === "tool_use") {
      log.info("Claude requested tool use — MCP call needed");
      // Tool use is handled via the onToolUse callback above
    }

    callbacks.onComplete(fullText);
  } catch (err) {
    log.error({ err }, "Anthropic stream error");
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Non-streaming single-shot call (used after MCP tool results).
 * Returns the assistant's follow-up text.
 */
export async function sendToolResult(
  session: CallSession,
  toolUseId: string,
  toolResult: string,
): Promise<string> {
  const messages = buildMessages(session);

  // Append tool_result
  messages.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: toolResult,
      },
    ],
  });

  const response = await client.messages.create({
    model: env.anthropicModel,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages,
    tools: COTRACKPRO_TOOLS,
  });

  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  return textBlocks.map((b) => b.text).join(" ");
}
