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
import {
  ElevenLabsStream,
  type ElevenLabsStreamOptions,
} from "../services/elevenlabs.js";
import { STTStream, type STTStreamOptions } from "../services/stt.js";
import {
  streamResponse as realStreamResponse,
  sendToolResult as realSendToolResult,
} from "../services/anthropic.js";
import { callMCPTool as realCallMCPTool } from "../services/mcp.js";
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
import { SentenceBuffer } from "../core/sentenceBuffer.js";
import { makeSentencePipedCallbacks } from "../core/streamPipeline.js";

// ── Dependency-injection seam for tests ────────────────────────────────────
//
// `handleCallStream` depends on several stateful external services
// (ElevenLabs TTS, ElevenLabs STT, Anthropic Claude streaming, MCP
// tool calls). All of them touch real network endpoints and can't
// be driven from a unit test. This interface lets a characterization
// test inject fake replacements so the whole call pipeline can run
// in-process against scripted inputs.
//
// Production callers omit `depsOverride` and get the real
// implementations via `defaultDeps()`. Tests pass a `Partial<CallHandlerDeps>`
// with the fakes they care about; anything omitted falls through to
// the real implementation.
//
// The interfaces use structural typing (`TtsStreamLike`, `SttStreamLike`)
// so fakes don't have to extend the real classes — they just need to
// implement the method surface `handleCallStream` actually uses.
// See tests/fakes/ for the in-test implementations.

/** The subset of `ElevenLabsStream` that `handleCallStream` uses. */
export interface TtsStreamLike {
  connect(): Promise<void>;
  sendText(text: string): void;
  flush(): void;
  close(): void;
}

/** The subset of `STTStream` that `handleCallStream` uses. */
export interface SttStreamLike {
  connect(): Promise<void>;
  sendAudio(base64Audio: string): void;
  close(): void;
}

/**
 * The external collaborators `handleCallStream` needs. Tests override
 * any subset via the `depsOverride` parameter below; production uses
 * `defaultDeps()`.
 */
export interface CallHandlerDeps {
  /** Factory for a new TTS stream. Called once per utterance. */
  makeTtsStream: (opts: ElevenLabsStreamOptions) => TtsStreamLike;
  /** Factory for the STT stream. Called once per call in the `start` case. */
  makeSttStream: (opts: STTStreamOptions) => SttStreamLike;
  /** Stream a Claude response through to the supplied callbacks. */
  streamResponse: typeof realStreamResponse;
  /** Send a tool result and stream Claude's follow-up. */
  sendToolResult: typeof realSendToolResult;
  /** Invoke the CoTrackPro MCP server. */
  callMcpTool: typeof realCallMCPTool;
}

/** Real-implementation defaults. The only values used in production. */
function defaultDeps(): CallHandlerDeps {
  return {
    makeTtsStream: (opts) => new ElevenLabsStream(opts),
    makeSttStream: (opts) => new STTStream(opts),
    streamResponse: realStreamResponse,
    sendToolResult: realSendToolResult,
    callMcpTool: realCallMCPTool,
  };
}

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
// Previously this file declared a SENTENCE_END regex + a
// SENTENCE_FLUSH_TIMEOUT_MS constant and inlined the sentence buffer
// as closure state inside handleCallStream. Both have moved into the
// SentenceBuffer class in src/core/sentenceBuffer.ts, which is
// directly unit-testable via tests/sentenceBuffer.test.ts. The
// characterization tests in tests/callHandler.test.ts still cover
// the end-to-end handler behavior, so any regression surfaces at
// both layers.

/**
 * Handle a Twilio bidirectional media stream WebSocket connection.
 */
export async function handleCallStream(
  twilioWs: WebSocket,
  depsOverride?: Partial<CallHandlerDeps>,
): Promise<void> {
  // Merge real defaults with any test-supplied overrides. Production
  // callers pass nothing and get the real services.
  const deps: CallHandlerDeps = { ...defaultDeps(), ...depsOverride };
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
  // Typed to the `Like` interfaces so test fakes can be assigned here
  // without extending the real classes.
  let sttStream: SttStreamLike | undefined;
  let currentTts: TtsStreamLike | undefined;
  let isAssistantSpeaking = false;
  let markCounter = 0;
  let pendingUtterance: string | null = null;
  // Sentence-piping state lives in SentenceBuffer (Pass 1 of the
  // callHandler refactor). Initialized once per call; `reset()` is
  // called between utterances, `dispose()` on cleanup.
  const sentenceBuffer = new SentenceBuffer({
    onSentence: (text) => {
      // Always send through the CURRENT TTS stream, which may change
      // between utterances (e.g. after a tool-use round-trip). The
      // buffer fires synchronously from push/flushRemaining so
      // currentTts is guaranteed to be set by the time a sentence
      // is emitted (the onTextDelta / onComplete callbacks in
      // makeSentencePipedCallbacks ensure currentTts is set before
      // delegating to the buffer).
      currentTts?.sendText(text);
    },
  });

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
  async function createTtsStream(): Promise<TtsStreamLike> {
    if (!session) throw new Error("No session");

    // Goes through the DI seam so tests can inject a FakeTtsStream.
    const tts = deps.makeTtsStream({
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

  // (sentence buffer / flush timer helpers were removed in Pass 1 of
  // the callHandler.ts refactor — they now live in src/core/sentenceBuffer.ts
  // via the `SentenceBuffer` instance declared at the top of this
  // function. The `push()` / `flushRemaining()` / `reset()` /
  // `dispose()` API replaces the ad-hoc `resetFlushTimer` +
  // `clearFlushTimer` helpers that used to live here.)

  // ── Helper: mark processing done and drain queued utterance ──────────────
  function finishProcessing(): void {
    if (session) session.isProcessing = false;
    if (pendingUtterance) {
      const queued = pendingUtterance;
      pendingUtterance = null;
      processUserUtterance(queued);
    }
  }

  // The `makeSentencePipedCallbacks` helper lives in
  // src/core/streamPipeline.ts as of Pass 2 of the callHandler
  // refactor. We wrap it below with a thin `buildPipelineCallbacks`
  // that supplies the handler-scoped context (TTS getter/setter,
  // sentence buffer, create factory, log).
  function buildPipelineCallbacks(
    callLog: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
    onDone: (fullText: string) => void,
    onFail: (err: Error) => void,
  ): import("../services/anthropic.js").StreamCallbacks {
    return makeSentencePipedCallbacks(
      {
        getCurrentTts: () => currentTts,
        setCurrentTts: (tts) => {
          currentTts = tts;
        },
        createTtsStream,
        sentenceBuffer,
        log: callLog,
      },
      onDone,
      onFail,
    );
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
      // Reset sentence buffer for this utterance. We no longer pre-
      // create a TTS stream here — the previous pattern eagerly
      // connected one in parallel with Claude but never used it
      // because the greeting path already set `currentTts`. The
      // lazy path inside makeSentencePipedCallbacks handles any
      // real cold-start case.
      sentenceBuffer.reset();

      const callbacks = buildPipelineCallbacks(
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

      await deps.streamResponse(session, {
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
          const result = await deps.callMcpTool(toolName, toolInput);
          const mcpDurationMs = Date.now() - mcpStartMs;
          callLog.info({ toolName, mcpMs: mcpDurationMs }, "MCP tool call complete");

          // Persist tool call to DynamoDB
          appendToolCall(session!.callSid, {
            toolName,
            durationMs: mcpDurationMs,
            timestamp: new Date().toISOString(),
            success: !result.startsWith("Error:") && !result.startsWith("Tool call failed"),
          }).catch(() => {});

          // Stream the follow-up through a fresh TTS connection.
          // `currentTts` is assigned here explicitly so the
          // lazy-create branch inside makeSentencePipedCallbacks
          // never fires — we want the exact stream we just built.
          currentTts = await createTtsStream();
          sentenceBuffer.reset();

          const toolCallbacks = buildPipelineCallbacks(
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

          await deps.sendToolResult(session!, toolUseId, result, toolCallbacks);
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

          // Initialize STT via the DI seam so tests can inject a
          // FakeSttStream that emits scripted transcripts.
          sttStream = deps.makeSttStream({
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
    // Dispose the sentence buffer first so any in-flight idle timer
    // can't fire after the TTS stream is closed. The `disposed`
    // flag also makes any late `push()` or `flushRemaining()` a no-op.
    sentenceBuffer.dispose();
    // Close STT/TTS next so their onChars/onSeconds callbacks fire
    // and populate session.costMetrics BEFORE we finalize the cost
    // summary.
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
