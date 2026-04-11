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
  TranscriptEntry,
} from "../types/index.js";
import {
  createSession,
  destroySession,
  isAtCapacity,
  onSessionDestroy,
  sessionCount,
  touchSession,
} from "../utils/sessions.js";
import { logger } from "../utils/logger.js";
import { ElevenLabsStream } from "../services/elevenlabs.js";
import { STTStream } from "../services/stt.js";
import { streamResponse, sendToolResult } from "../services/anthropic.js";
import { callMCPTool } from "../services/mcp.js";
import {
  createCallRecord,
  completeCallRecord,
  updateCallStatus,
  updateCallCost,
  appendToolCall,
  maskPhoneNumber,
} from "../services/dynamo.js";
import {
  GREETINGS_ULAW,
  HOLD_ULAW,
  ERROR_GENERIC_ULAW,
  ERROR_TOOL_ULAW,
  HOLD_TEXT,
  ERROR_GENERIC_TEXT,
  ERROR_TOOL_TEXT,
} from "../audio/prerecorded.js";
import { estimateCallCost } from "../utils/costEstimator.js";

// ── Role-adaptive, trauma-informed greetings ─────────────────────────────────
function getRoleGreeting(role: CoTrackProRole): string {
  switch (role) {
    case "kid_teen":
      return (
        "Hey there. Welcome to CoTrack Pro. " +
        "This is a safe place where you can talk about what's going on. " +
        "There are no wrong answers, and you can stop anytime you want. " +
        "What's on your mind?"
      );
    case "parent":
      return (
        "Welcome to CoTrack Pro. I'm here to help with documentation, " +
        "safety planning, and co-parenting support. " +
        "Everything we talk about today is on your terms, and we can go at your pace. " +
        "How can I help you today?"
      );
    case "attorney":
    case "gal":
    case "judge":
      return (
        "Welcome to CoTrack Pro. I'm ready to assist with documentation, " +
        "case organization, and evidence support. " +
        "How can I help you today?"
      );
    case "therapist":
    case "social_worker":
    case "school_counselor":
      return (
        "Welcome to CoTrack Pro. I'm here to support your documentation " +
        "and help organize observations. " +
        "What are you working on today?"
      );
    case "advocate":
      return (
        "Welcome to CoTrack Pro. I'm here to support your work " +
        "with safety planning, documentation, and resource connection. " +
        "How can I help today?"
      );
    default:
      return (
        "Welcome to CoTrack Pro. I'm here to help with documentation, " +
        "safety planning, and co-parenting support. " +
        "How can I help you today?"
      );
  }
}

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

  // ── E-2: Concurrent-session cap ─────────────────────────────────────
  // Reject new streams BEFORE we allocate any downstream resources
  // (STT WebSocket, Claude stream, ElevenLabs TTS). The check is
  // deliberately racy — if two connections arrive at exactly the same
  // time they could both see `isAtCapacity() === false` and both
  // proceed, transiently pushing sessionCount past the cap by 1. In
  // practice that's a rounding error relative to the cap value, and
  // making it strictly atomic would require locking the accept path
  // which isn't worth the complexity.
  //
  // Twilio Media Streams protocol has no clean way to return an error
  // code to the caller — the best we can do is close the WS with a
  // short reason. Twilio will hang up the call and the caller hears a
  // busy signal. This is the bounded-damage outcome of a flood.
  if (isAtCapacity()) {
    log.warn(
      { sessionCount: sessionCount() },
      "WS session cap reached — rejecting new Twilio stream",
    );
    try {
      // 1013 = Try Again Later (defined in RFC 6455).
      twilioWs.close(1013, "server busy");
    } catch {
      /* ignore — socket may already be closing */
    }
    return;
  }

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
      onChars: (chars) => {
        // Accumulate billable TTS chars for cost metrics
        if (session) session.costMetrics.ttsChars += chars;
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

  // ── Helper: play pre-recorded audio chunks to Twilio ────────────────────
  // Paces frames at 20ms intervals to match Twilio's 8kHz mulaw playback rate.
  // This is the zero-cost fast path for fixed phrases (greetings, holds,
  // error messages). Tracks cached chars for cost metrics.
  async function playCached(chunks: string[], textForMetrics: string): Promise<void> {
    if (!chunks || chunks.length === 0) return;
    if (session) session.costMetrics.ttsCharsCached += textForMetrics.length;
    isAssistantSpeaking = true;
    for (const chunk of chunks) {
      if (twilioWs.readyState !== 1) break;
      sendToTwilio(chunk);
      // Pace at 20ms per frame to match Twilio's playback rate
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    sendMark();
  }

  /**
   * Try to play a fixed phrase from the audio cache; fall back to live TTS
   * if the cache entry is missing. Returns true if played from cache.
   */
  async function playCachedOrSpeak(
    cachedChunks: string[] | undefined,
    text: string,
  ): Promise<boolean> {
    if (cachedChunks && cachedChunks.length > 0) {
      await playCached(cachedChunks, text);
      return true;
    }
    await speak(text);
    return false;
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

  // ── Helper: build sentence-piped StreamCallbacks ─────────────────────────
  // Extracted from processUserUtterance to avoid duplicating the sentence
  // buffer + flush timer + TTS piping logic between primary and tool paths.
  function makeSentencePipedCallbacks(
    ttsReady: Promise<ElevenLabsStream>,
    callLog: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
    onDone: (fullText: string) => void,
    onFail: (err: Error) => void,
  ): import("../services/anthropic.js").StreamCallbacks {
    let firstDeltaReceived = false;
    const startMs = Date.now();

    return {
      onTextDelta: async (delta) => {
        // Ensure TTS is connected before sending the first delta
        if (!currentTts) {
          currentTts = await ttsReady;
        }
        if (!firstDeltaReceived) {
          firstDeltaReceived = true;
          callLog.info({ ttftMs: Date.now() - startMs }, "Time to first text delta");
        }

        sentenceBuffer += delta;

        // Send complete sentences to TTS for more natural pacing
        const parts = sentenceBuffer.split(SENTENCE_END);
        if (parts.length > 1) {
          const toSend = parts.slice(0, -1).join(" ") + " ";
          currentTts?.sendText(toSend);
          sentenceBuffer = parts[parts.length - 1]!;
          clearFlushTimer();
        }
        if (sentenceBuffer) resetFlushTimer();
      },

      onComplete: async (fullText) => {
        clearFlushTimer();
        if (!currentTts) {
          currentTts = await ttsReady;
        }
        if (sentenceBuffer.trim()) {
          currentTts.sendText(sentenceBuffer + " ");
        }
        currentTts.flush();
        sentenceBuffer = "";

        callLog.info({ totalMs: Date.now() - startMs }, "Response complete");
        onDone(fullText);
      },

      onError: onFail,
    };
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
    const utteranceStartMs = Date.now();

    // Add user turn to history
    session.conversationHistory.push({
      role: "user",
      content: text,
      timestamp: Date.now(),
    });

    callLog.info({ utterance: text }, "Processing user utterance");

    try {
      // Start TTS connection and Anthropic stream in parallel.
      const ttsReady = createTtsStream();
      sentenceBuffer = "";

      const callbacks = makeSentencePipedCallbacks(
        ttsReady,
        callLog,
        (fullText) => {
          session!.conversationHistory.push({
            role: "assistant",
            content: fullText,
            timestamp: Date.now(),
          });
          callLog.info(
            { utteranceTotalMs: Date.now() - utteranceStartMs },
            "Utterance fully processed",
          );
          finishProcessing();
        },
        (err) => {
          callLog.error({ err }, "Claude error");
          playCachedOrSpeak(
            ERROR_GENERIC_ULAW[session!.voiceId],
            ERROR_GENERIC_TEXT,
          );
          finishProcessing();
        },
      );

      await streamResponse(session, {
        ...callbacks,

        onToolUse: async (toolName, toolInput, toolUseId) => {
          callLog.info({ toolName }, "Claude requested MCP tool call");

          // Tell caller we're working on it. Close the current TTS stream
          // first so cached audio plays cleanly, then play the hold phrase
          // from the pre-recorded cache (falls back to live TTS on cache miss).
          currentTts?.close();
          currentTts = undefined;
          await playCachedOrSpeak(HOLD_ULAW[session!.voiceId], HOLD_TEXT);

          // Call the CoTrackPro MCP server
          const mcpStartMs = Date.now();
          const result = await callMCPTool(toolName, toolInput);
          const mcpDurationMs = Date.now() - mcpStartMs;
          callLog.info({ toolName, mcpMs: mcpDurationMs }, "MCP tool call complete");

          // Persist tool call to DynamoDB
          appendToolCall(session!.callSid, {
            toolName,
            durationMs: mcpDurationMs,
            timestamp: new Date().toISOString(),
            success: !result.startsWith("Error:") && !result.startsWith("Tool call failed"),
          }).catch(() => {});

          // Stream the follow-up through a fresh TTS connection
          currentTts = await createTtsStream();
          sentenceBuffer = "";

          const toolCallbacks = makeSentencePipedCallbacks(
            Promise.resolve(currentTts),
            callLog,
            (fullText) => {
              session!.conversationHistory.push({
                role: "assistant",
                content: fullText,
                timestamp: Date.now(),
              });
              callLog.info(
                { utteranceTotalMs: Date.now() - utteranceStartMs },
                "Tool follow-up fully processed",
              );
              finishProcessing();
            },
            (err) => {
              callLog.error({ err }, "Claude tool follow-up error");
              playCachedOrSpeak(
                ERROR_TOOL_ULAW[session!.voiceId],
                ERROR_TOOL_TEXT,
              );
              finishProcessing();
            },
          );

          await sendToolResult(session!, toolUseId, result, toolCallbacks);
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

          // Persist call record to DynamoDB
          const callerNumber = startMsg.start.customParameters?.callerNumber ?? "unknown";
          const direction = (startMsg.start.customParameters?.direction as "inbound" | "outbound") ?? "inbound";
          createCallRecord({
            callSid,
            role,
            direction,
            callerNumber: maskPhoneNumber(callerNumber),
            startedAt: new Date().toISOString(),
            status: "active",
            turnCount: 0,
            transcript: [],
            safetyEvents: [],
            toolCalls: [],
          }).catch((err) => log.error({ err }, "Failed to create DynamoDB call record"));

          // Register for forced cleanup (zombie TTL / max duration reaping)
          onSessionDestroy(callSid, () => {
            log.warn({ callSid }, "Session force-reaped — cleaning up");
            updateCallStatus(callSid, "force-reaped").catch(() => {});
            cleanup();
            twilioWs.close();
          });

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
            onSeconds: (secs) => {
              if (session) session.costMetrics.sttSecs += secs;
            },
          });

          // Greet the caller with a role-appropriate, trauma-informed greeting.
          // Prefer the pre-recorded audio cache (zero TTS cost, zero latency);
          // fall back to live TTS if the cache is empty (generator not run).
          const greeting = getRoleGreeting(role);

          session.conversationHistory.push({
            role: "assistant",
            content: greeting,
            timestamp: Date.now(),
          });

          // Connect STT and play greeting in parallel
          await Promise.all([
            sttStream.connect(),
            playCachedOrSpeak(GREETINGS_ULAW[role], greeting),
          ]);
          break;
        }

        case "media": {
          // Forward caller audio to STT
          if (sttStream && msg.event === "media") {
            sttStream.sendAudio(msg.media.payload);
            if (session) touchSession(session.callSid);
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
    // Close STT/TTS first so their onChars/onSeconds callbacks fire and
    // populate session.costMetrics BEFORE we finalize the cost summary.
    sttStream?.close();
    currentTts?.close();
    if (session) {
      // Persist completed call record to DynamoDB
      const durationSecs = Math.round((Date.now() - session.createdAt) / 1000);
      const transcript: TranscriptEntry[] = session.conversationHistory
        .filter((t) => typeof t.content === "string")
        .map((t) => ({
          role: t.role,
          text: t.content as string,
          timestamp: new Date(t.timestamp).toISOString(),
        }));
      const turnCount = transcript.length;

      completeCallRecord(
        session.callSid,
        new Date().toISOString(),
        durationSecs,
        transcript,
        turnCount,
      ).catch((err) => log.error({ err }, "Failed to complete DynamoDB call record"));

      // Finalize and emit the cost summary for the call
      const costSummary = estimateCallCost(session.costMetrics);
      log.info(
        {
          callSid: session.callSid,
          durationSecs,
          turnCount,
          ...costSummary,
        },
        "cost.call.summary",
      );
      updateCallCost(session.callSid, costSummary).catch((err) =>
        log.error({ err }, "Failed to persist cost summary"),
      );

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
