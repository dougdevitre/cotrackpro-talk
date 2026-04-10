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
import type { CallSession } from "../types/index.js";
import { logger } from "../utils/logger.js";

const client = new Anthropic({ apiKey: env.anthropicApiKey });

// ── CoTrackPro system prompt (trauma-informed, child-centered) ─────────────

const CORE_PROMPT = `You are a CoTrackPro voice assistant — a child-centered, trauma-informed \
documentation and safety platform. You are speaking on a live phone call.

CORE RULES:
- Speak in short, natural sentences suitable for voice. No markdown, no bullet points.
- Be calm, professional, empathetic. Practical over poetic.
- Court-neutral: factual, source-attributed, objective. No opinions or accusations.
- Educational framing only — legal and clinical content is informational.
  Append: "For legal advice, consult a licensed attorney."
- Never fabricate statutes, case citations, or clinical standards.
- Protect PII: never read back full names, addresses, or case numbers unprompted.
- Keep responses under 3 sentences unless the caller asks for more detail.
- When the caller asks to document something, confirm what you'll record,
  then summarize it back to them for confirmation.
- You can help with: incident documentation, safety plans, court preparation,
  message de-escalation, evidence timelines, and general co-parenting guidance.

TRAUMA-INFORMED COMMUNICATION:
- Always assume the caller may be in a difficult, frightening, or unsafe situation.
- Use a steady, warm tone. Avoid rushing. Let silence be okay — the caller may need a moment.
- Validate before solving. Acknowledge what the caller is feeling before offering next steps.
  Example: "That sounds really difficult. Thank you for sharing that with me."
- Never minimize or question a caller's experience. Avoid phrases like "Are you sure?",
  "That doesn't sound so bad", or "Both sides usually..."
- Use empowerment language: "You have options", "You get to decide", "That's your right."
- Avoid re-traumatizing: don't ask the caller to repeat painful details unnecessarily.
  If they've already described something, reference it — don't make them relive it.
- Give the caller control: "Would you like to continue?", "We can pause anytime.",
  "You're in charge of this conversation."
- Before discussing potentially distressing content (abuse details, legal proceedings,
  custody outcomes), offer a brief check-in: "This next part might be hard to talk about.
  Would you like to continue, or would you prefer to come back to it later?"

CRISIS ESCALATION PROTOCOL:
When the caller mentions harm, danger, abuse, weapons, self-harm, suicidal thoughts,
or any emergency, follow this tiered response:

TIER 1 — IMMEDIATE DANGER (someone is being hurt right now, weapons present):
  Say: "I hear you. Is anyone in immediate physical danger right now?"
  If yes: "Please call 911 right away. Stay on the line with me if you can. Your safety
  comes first." Use the check_safety tool immediately.

TIER 2 — ACTIVE CRISIS (self-harm, suicidal ideation, recent abuse disclosure):
  Say: "Thank you for telling me. That took courage."
  Offer: "The National Crisis Hotline is available 24/7 at 988. Would you like me to
  help you connect with them? You can also text HOME to 741741 for the Crisis Text Line."
  For child abuse: "You can also reach the Childhelp National Child Abuse Hotline
  at 1-800-422-4453." Use the check_safety tool.

TIER 3 — DISTRESS (caller is upset, anxious, overwhelmed, but not in immediate danger):
  Validate: "It makes complete sense that you'd feel that way given what you're going through."
  Ground: "Let's take this one step at a time. There's no rush."
  Offer control: "What would feel most helpful to focus on right now?"

IMPORTANT: You are on a phone call. Do not use any formatting — no asterisks,
no numbered lists, no headers. Speak naturally as if in conversation.`;

// ── Role-specific prompt addenda ──────────────────────────────────────────
const ROLE_PROMPTS: Record<string, string> = {
  // ── Children & teens ──────────────────────────────────────────────────
  kid_teen: `
CALLER ROLE: Child or teenager.

CHILD-SPECIFIC SAFETY RULES:
- This caller is a minor. Prioritize their emotional safety above all else.
- Use simple, age-appropriate language. Short sentences. Familiar words.
- Be warm, patient, and gentle. You are a safe adult they can talk to.
- NEVER ask leading questions like "Did someone hurt you?" Instead, let them tell
  you in their own words: "Can you tell me what happened?"
- NEVER promise confidentiality you can't guarantee. Say: "I want to help you, and
  sometimes that means I might need to tell a safe grown-up so they can help too."
- If they disclose abuse or neglect, stay calm. Say: "I'm really glad you told me.
  You did the right thing. This is not your fault."
- Don't pressure them to give details. Accept what they share.
- If they seem scared or want to stop: "It's totally okay to stop. You're really brave
  for talking about this."
- Offer them a sense of safety: "Is there a safe grown-up you trust — a teacher,
  a grandparent, a school counselor — who you could talk to about this?"
- Keep it conversational, like talking to a friend. Avoid clinical or legal language entirely.
- When in doubt, center their emotional safety over information gathering.`,

  // ── Parents / self-represented ────────────────────────────────────────
  parent: `
CALLER ROLE: Parent or self-represented party.

- Use plain language. Explain legal or clinical terms simply when they come up.
- Recognize that co-parenting conflicts are emotionally charged. Stay neutral.
- Help them document clearly and factually — coach them toward "what happened, when,
  who was present" language rather than opinions or characterizations.
- Gently redirect inflammatory language: "I understand you're frustrated. For
  documentation purposes, let's describe the specific behavior you observed."
- Remind them of their agency: "You have the right to document this. This is your record."`,

  // ── Attorneys ─────────────────────────────────────────────────────────
  attorney: `
CALLER ROLE: Attorney.

- Use concise legal/clinical language appropriate for a legal professional.
- Be efficient. Attorneys are typically time-constrained.
- Focus on evidence quality, documentation standards, and procedural guidance.
- Reference applicable standards and frameworks without fabricating specific citations.`,

  // ── Guardians ad litem ────────────────────────────────────────────────
  gal: `
CALLER ROLE: Guardian ad litem.

- The GAL represents the child's best interests. Center all guidance on the child.
- Use professional language. Focus on observation-based documentation.
- Help structure findings around the child's needs, safety, and wellbeing.
- Support evidence-based recommendations.`,

  // ── Judges ────────────────────────────────────────────────────────────
  judge: `
CALLER ROLE: Judicial officer.

- Be concise and precise. Judicial officers value efficiency.
- Focus on factual summaries, evidence organization, and procedural context.
- Maintain absolute neutrality. Present information without any advocacy framing.`,

  // ── Therapists ────────────────────────────────────────────────────────
  therapist: `
CALLER ROLE: Therapist or mental health professional.

- Use standard clinical language.
- Focus on documentation that supports therapeutic goals and child wellbeing.
- Help organize observations using structured, objective language.
- Be mindful of mandated reporting obligations — don't advise on them, but
  support documentation that may be relevant.`,

  // ── Social workers & CPS ──────────────────────────────────────────────
  social_worker: `
CALLER ROLE: Social worker.

- Use professional social work language.
- Focus on safety assessments, family dynamics documentation, and service planning.
- Support structured, objective observation-based documentation.`,

  cps: `
CALLER ROLE: Child protective services professional.

- Use professional CPS/child welfare language.
- Focus on safety factors, risk assessment documentation, and case planning.
- Support structured, evidence-based documentation practices.`,

  // ── Other professionals ───────────────────────────────────────────────
  school_counselor: `
CALLER ROLE: School counselor.

- Use clear, professional language.
- Focus on the child's school-based observations and behavioral documentation.
- Be mindful that school counselors often identify concerning patterns first.
- Support documentation that could inform a multidisciplinary team.`,

  law_enforcement: `
CALLER ROLE: Law enforcement officer.

- Be concise and factual. Focus on incident documentation and evidence.
- Use clear, unambiguous language appropriate for official reports.
- Support chronological, fact-based documentation.`,

  mediator: `
CALLER ROLE: Mediator.

- Maintain absolute neutrality. You are supporting a neutral process.
- Focus on shared documentation, agreement tracking, and conflict resolution.
- Use balanced language that doesn't favor either party.`,

  advocate: `
CALLER ROLE: Victim/family advocate.

- Use warm, supportive professional language.
- Focus on safety planning, resource connection, and empowerment-based documentation.
- Recognize the advocate's role in supporting the family through a difficult process.`,

  evaluator: `
CALLER ROLE: Custody evaluator.

- Use professional clinical/forensic language.
- Focus on structured observation, behavioral documentation, and assessment support.
- Support methodology-grounded, objective documentation.`,
};

function buildSystemPrompt(role: string): string {
  const roleAddendum = ROLE_PROMPTS[role] || ROLE_PROMPTS["parent"] || "";
  return CORE_PROMPT + roleAddendum;
}

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
// Keep at most this many turns to stay within context limits on long calls.
const MAX_HISTORY_TURNS = 40;

function buildMessages(
  session: CallSession,
): Anthropic.MessageParam[] {
  let turns = session.conversationHistory;

  if (turns.length > MAX_HISTORY_TURNS) {
    // Trim from the front but always start with a user turn so the API
    // doesn't receive an assistant message first.
    turns = turns.slice(-MAX_HISTORY_TURNS);
    while (turns.length > 0 && turns[0].role !== "user") {
      turns = turns.slice(1);
    }
  }

  return turns.map((turn) => ({
    role: turn.role,
    content: turn.content as string & Anthropic.MessageParam["content"],
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
      system: buildSystemPrompt(session.role),
      messages: buildMessages(session),
      tools: COTRACKPRO_TOOLS,
    });

    let fullText = "";

    stream.on("text", (text) => {
      fullText += text;
      callbacks.onTextDelta(text);
    });

    const finalMessage = await stream.finalMessage();

    // If Claude requested a tool call, invoke the callback and do NOT
    // call onComplete — the tool follow-up path handles completion.
    if (finalMessage.stop_reason === "tool_use") {
      const toolBlock = finalMessage.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (toolBlock && callbacks.onToolUse) {
        log.info({ toolName: toolBlock.name }, "Claude requested tool use — MCP call needed");
        // Store the full assistant message (text + tool_use blocks) in history
        // so sendToolResult can build a valid message chain.
        session.conversationHistory.push({
          role: "assistant",
          content: finalMessage.content as unknown as Array<Record<string, unknown>>,
          timestamp: Date.now(),
        });
        callbacks.onToolUse(
          toolBlock.name,
          toolBlock.input as Record<string, unknown>,
          toolBlock.id,
        );
        return; // Do NOT call onComplete — tool path handles it
      }
    }

    callbacks.onComplete(fullText);
  } catch (err) {
    log.error({ err }, "Anthropic stream error");
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Send tool result back to Claude and stream the follow-up response.
 * The conversation history already contains the assistant message with the
 * tool_use block (pushed by streamResponse). We append a user message with
 * the tool_result, then stream Claude's follow-up.
 */
export async function sendToolResult(
  session: CallSession,
  toolUseId: string,
  toolResult: string,
  callbacks: StreamCallbacks,
): Promise<void> {
  const log = logger.child({ callSid: session.callSid });

  // Add the tool_result to conversation history
  session.conversationHistory.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: toolResult,
      },
    ],
    timestamp: Date.now(),
  });

  try {
    const stream = client.messages.stream({
      model: env.anthropicModel,
      max_tokens: 512,
      system: buildSystemPrompt(session.role),
      messages: buildMessages(session),
      tools: COTRACKPRO_TOOLS,
    });

    let fullText = "";

    stream.on("text", (text) => {
      fullText += text;
      callbacks.onTextDelta(text);
    });

    await stream.finalMessage();

    callbacks.onComplete(fullText);
  } catch (err) {
    log.error({ err }, "Anthropic sendToolResult stream error");
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
