/**
 * handlers/callHandler.ts — Voice call orchestration pipeline
 *
 * This is the core of the contact center. It wires together:
 *
 *   Twilio (mulaw audio in/out)
 *     ↕ WebSocket
 *   STT (ElevenLabs Scribe realtime)
 *     ↓ transcribed text
 *   Claude (Anthropic streaming + CoTrackPro MCP tools)
 *     ↓ text deltas
 *   TTS (ElevenLabs streaming, ulaw_8000 output)
 *     ↕ WebSocket
 *   Twilio (plays audio back to caller)
 *
 * FLOW:
 * 1. Twilio connects → we create a session + STT + greeting TTS
 * 2. Caller speaks → Twilio streams mulaw → STT transcribes
 * 3. STT commits utterance → we send to Claude (streaming)
 * 4. Claude streams text deltas → we pipe each sentence to TTS
 * 5. TTS streams ulaw_8000 audio → we send to Twilio
 * 6. If Claude requests a tool → we call MCP → feed result back → continue
 *
 * BARGE-IN: When the caller starts speaking while the assistant is still
 * talking, we send a "clear" message to Twilio to stop playback, then
 * process the new utterance.
 */

import type { WebSocket } from "ws";
import type {
  TwilioInboundMessage,
  TwilioStartMessage,
  CoTrackProRole,
  CallSession,
} from "../types/index.js";
import { createSession, destroySession, getSession } from "../utils/sessions.js";
import { logger } from "../utils/logger.js";
import { ElevenLabsStream } from "../services/elevenlabs.js";
import { STTStream } from "../services/stt.js";
import { streamResponse, sendToolResult } from "../services/anthropic.js";
import { callMCPTool } from "../services/mcp.js";

// ── Sentence boundary detection for natural TTS pacing ──────────────────────
// Matches a sentence-ending punctuation mark followed by whitespace.
// Uses a lookbehind so the punctuation stays with the preceding sentence.
const SENTENCE_END = /(?<=[.!?])\s+/;

// If no sentence boundary arrives within this window, flush the buffer
// to TTS anyway so the caller doesn't hear prolonged silence.
const SENTENCE_FLUSH_TIMEOUT_MS = 500;

/**
 * Handle a Twilio bidirectional media stream WebSocket connection.
 */
export async function handleCallStream(twilioWs: WebSocket): Promise<void> {
  const log = logger.child({ handler: "callStream" });
  let session: CallSession | undefined;
  let sttStream: STTStream | undefined;
  let currentTts: ElevenLabsStream | undefined;
  let sentenceBuffer = "";
  let isAssistantSpeaking = false;
  let markCounter = 0;
  let pendingUtterance: string | null = null;
  let sentenceFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Helper: send media to Twilio ────────────────────────────────────────
  // Pre-built JSON envelope — avoids JSON.stringify on every audio chunk
  // (hundreds per second). The streamSid is set once on "start".
  let mediaJsonPrefix = "";

  function initMediaPrefix(streamSid: string): void {
    mediaJsonPrefix = `{"event":"media","streamSid":"${streamSid}","media":{"payload":"`;
  }
  const mediaJsonSuffix = '"}}';

  function sendToTwilio(base64Audio: string): void {
    if (!session || twilioWs.readyState !== 1) return;
    twilioWs.send(mediaJsonPrefix + base64Audio + mediaJsonSuffix);
  }

  // ── Helper: send mark to Twilio (for tracking playback) ─────────────────
  function sendMark(): string {
    const name = `mark_${++markCounter}`;
    if (session && twilioWs.readyState === 1) {
      twilioWs.send(
        JSON.stringify({
          event: "mark",
          streamSid: session.streamSid,
          mark: { name },
        }),
      );
    }
    return name;
  }

  // ── Helper: clear Twilio audio buffer (barge-in) ────────────────────────
  function clearTwilioBuffer(): void {
    if (session && twilioWs.readyState === 1) {
      twilioWs.send(
        JSON.stringify({
          event: "clear",
          streamSid: session.streamSid,
        }),
      );
    }
    isAssistantSpeaking = false;
  }

  // ── Helper: create a new TTS stream for an utterance ────────────────────
  async function createTtsStream(): Promise<ElevenLabsStream> {
    if (!session) throw new Error("No session");

    const tts = new ElevenLabsStream({
      voiceId: session.voiceId,
      callSid: session.callSid,
      onAudio: (b64) => {
        isAssistantSpeaking = true;
        sendToTwilio(b64);
      },
      onDone: () => {
        sendMark();
        log.debug("TTS utterance complete");
      },
      onError: (err) => {
        log.error({ err }, "TTS error");
      },
    });

    await tts.connect();
    return tts;
  }

  // ── Helper: speak a complete text through TTS ───────────────────────────
  async function speak(text: string): Promise<void> {
    if (!text.trim()) return;

    currentTts = await createTtsStream();
    currentTts.sendText(text);
    currentTts.flush();
  }

  // ── Helper: reset the sentence-flush timer ──────────────────────────────
  // After each text delta, (re)start a timer. If no sentence boundary
  // arrives within SENTENCE_FLUSH_TIMEOUT_MS, flush the buffer to TTS
  // so the caller doesn't hear prolonged silence on long clauses.
  function resetFlushTimer(): void {
    if (sentenceFlushTimer) clearTimeout(sentenceFlushTimer);
    sentenceFlushTimer = setTimeout(() => {
      if (sentenceBuffer.trim() && currentTts) {
        currentTts.sendText(sentenceBuffer + " ");
        sentenceBuffer = "";
      }
    }, SENTENCE_FLUSH_TIMEOUT_MS);
  }

  function clearFlushTimer(): void {
    if (sentenceFlushTimer) {
      clearTimeout(sentenceFlushTimer);
      sentenceFlushTimer = null;
    }
  }

  // ── Helper: mark processing done and drain queued utterance ──────────────
  function finishProcessing(): void {
    if (session) session.isProcessing = false;
    if (pendingUtterance) {
      const queued = pendingUtterance;
      pendingUtterance = null;
      processUserUtterance(queued);
    }
  }

  // ── Helper: process a user utterance through Claude → TTS ───────────────
  async function processUserUtterance(text: string): Promise<void> {
    if (!session) return;
    if (!text.trim()) return;

    // If already processing, queue the latest utterance (overwrite any
    // previously queued one — the caller's most recent speech wins).
    if (session.isProcessing) {
      const callLog = logger.child({ callSid: session.callSid });
      callLog.info({ queued: text }, "Queuing utterance — already processing");
      pendingUtterance = text;
      return;
    }

    session.isProcessing = true;
    const callLog = logger.child({ callSid: session.callSid });

    // Add user turn to history
    session.conversationHistory.push({
      role: "user",
      content: text,
      timestamp: Date.now(),
    });

    callLog.info({ utterance: text }, "Processing user utterance");

    try {
      // Start TTS connection and Anthropic stream in parallel.
      // Claude's time-to-first-token (~300ms+) gives the TTS WebSocket
      // plenty of time to complete its handshake concurrently.
      const ttsReady = createTtsStream();
      sentenceBuffer = "";

      await streamResponse(session, {
        onTextDelta: async (delta) => {
          // Ensure TTS is connected before sending the first delta
          if (!currentTts) {
            currentTts = await ttsReady;
          }

          sentenceBuffer += delta;

          // Send complete sentences to TTS for more natural pacing
          const parts = sentenceBuffer.split(SENTENCE_END);
          if (parts.length > 1) {
            // Send all complete sentences, preserving original punctuation
            const toSend = parts.slice(0, -1).join(" ") + " ";
            currentTts?.sendText(toSend);
            sentenceBuffer = parts[parts.length - 1]!;
            clearFlushTimer();
          }
          // If text is accumulating without a sentence boundary, start a
          // timer to flush it so the caller doesn't hear prolonged silence.
          if (sentenceBuffer) resetFlushTimer();
        },

        onComplete: async (fullText) => {
          clearFlushTimer();
          // Ensure TTS is connected
          if (!currentTts) {
            currentTts = await ttsReady;
          }
          // Flush any remaining text
          if (sentenceBuffer.trim()) {
            currentTts.sendText(sentenceBuffer + " ");
          }
          currentTts.flush();
          sentenceBuffer = "";

          // Add assistant turn to history
          session!.conversationHistory.push({
            role: "assistant",
            content: fullText,
            timestamp: Date.now(),
          });
          finishProcessing();
        },

        onToolUse: async (toolName, toolInput, toolUseId) => {
          callLog.info({ toolName }, "Claude requested MCP tool call");

          // Tell caller we're working on it
          currentTts?.sendText("One moment while I look that up. ");
          currentTts?.flush();

          // Call the CoTrackPro MCP server
          const result = await callMCPTool(toolName, toolInput);

          // Send tool result back to Claude and stream the follow-up.
          // The assistant message with the tool_use block was already
          // stored in history by streamResponse.
          currentTts = await createTtsStream();
          sentenceBuffer = "";

          await sendToolResult(session!, toolUseId, result, {
            onTextDelta: (delta) => {
              sentenceBuffer += delta;
              const parts = sentenceBuffer.split(SENTENCE_END);
              if (parts.length > 1) {
                const toSend = parts.slice(0, -1).join(" ") + " ";
                currentTts?.sendText(toSend);
                sentenceBuffer = parts[parts.length - 1]!;
                clearFlushTimer();
              }
              if (sentenceBuffer) resetFlushTimer();
            },
            onComplete: (fullText) => {
              clearFlushTimer();
              if (sentenceBuffer.trim()) {
                currentTts?.sendText(sentenceBuffer + " ");
              }
              currentTts?.flush();
              sentenceBuffer = "";

              session!.conversationHistory.push({
                role: "assistant",
                content: fullText,
                timestamp: Date.now(),
              });
              finishProcessing();
            },
            onError: (err) => {
              callLog.error({ err }, "Claude tool follow-up error");
              speak(
                "I'm sorry, I had trouble processing the result. Could you please try again?",
              );
              finishProcessing();
            },
          });
        },

        onError: (err) => {
          callLog.error({ err }, "Claude error");
          speak(
            "I'm sorry, I'm having trouble processing that right now. Could you please try again?",
          );
          finishProcessing();
        },
      });
    } catch (err) {
      callLog.error({ err }, "processUserUtterance failed");
      finishProcessing();
    }
  }

  // ── Twilio WebSocket message handler ────────────────────────────────────
  twilioWs.on("message", async (data) => {
    try {
      const msg: TwilioInboundMessage = JSON.parse(data.toString());

      switch (msg.event) {
        case "connected":
          log.info("Twilio WS connected");
          break;

        case "start": {
          const startMsg = msg as TwilioStartMessage;
          const callSid = startMsg.start.callSid;
          const streamSid = startMsg.start.streamSid;

          // Determine role from custom parameters (default: parent)
          const role = (startMsg.start.customParameters?.role as CoTrackProRole) || "parent";

          session = createSession(callSid, streamSid, role);
          initMediaPrefix(streamSid);

          // Initialize STT
          sttStream = new STTStream({
            callSid,
            onPartial: (text) => {
              // Optional: you could use partials for barge-in detection
              if (isAssistantSpeaking && text.length > 3) {
                log.debug("Barge-in detected — clearing Twilio buffer");
                clearTwilioBuffer();
                currentTts?.close();
              }
            },
            onFinal: (text) => {
              log.info({ text }, "STT final transcript");
              processUserUtterance(text);
            },
            onError: (err) => {
              log.error({ err }, "STT error");
            },
          });

          // Greet the caller
          const greeting =
            "Welcome to CoTrack Pro. I'm here to help with documentation, " +
            "safety planning, and co-parenting support. How can I help you today?";

          session.conversationHistory.push({
            role: "assistant",
            content: greeting,
            timestamp: Date.now(),
          });

          // Connect STT and speak greeting in parallel — they're independent
          // and overlapping saves ~100-200ms of WebSocket handshake time.
          await Promise.all([sttStream.connect(), speak(greeting)]);
          break;
        }

        case "media": {
          // Forward caller audio to STT
          if (sttStream && msg.event === "media") {
            sttStream.sendAudio(msg.media.payload);
          }
          break;
        }

        case "mark": {
          // Audio playback reached this mark — assistant finished speaking
          log.debug({ mark: msg.mark.name }, "Twilio mark received");
          break;
        }

        case "stop": {
          log.info("Twilio stream stopped");
          cleanup();
          break;
        }
      }
    } catch (err) {
      log.error({ err }, "Error processing Twilio message");
    }
  });

  // ── Cleanup on disconnect ───────────────────────────────────────────────
  function cleanup(): void {
    clearFlushTimer();
    sttStream?.close();
    currentTts?.close();
    if (session) {
      destroySession(session.callSid);
    }
    session = undefined;
  }

  twilioWs.on("close", () => {
    log.info("Twilio WS closed");
    cleanup();
  });

  twilioWs.on("error", (err) => {
    log.error({ err }, "Twilio WS error");
    cleanup();
  });
}
