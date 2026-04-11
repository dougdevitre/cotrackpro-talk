/**
 * utils/sessions.ts — In-memory call session store
 *
 * SECURITY: Sessions are ephemeral and scoped to a single call.
 * No PII is persisted to disk.
 *
 * ── Why in-memory (and NOT Redis) ──────────────────────────────────────
 *
 * An earlier README TODO suggested "use Redis for session store" for
 * multi-instance deployments. This turns out to be the wrong move for a
 * real-time voice pipeline, and the TODO has been retracted. The
 * correct pattern is:
 *
 *   1. Each Twilio Media Stream WebSocket stays pinned to a single WS
 *      instance for its entire lifetime. No load balancer "stickiness"
 *      is needed — the WS handshake happens on one instance and the
 *      same connection delivers every audio chunk until hangup.
 *   2. Session state (audioBuffer, conversationHistory, voiceId,
 *      costMetrics, etc.) is therefore correctly scoped to that
 *      instance. It never needs to be visible to any other process.
 *   3. `touchSession()` is on the audio hot path — called on every
 *      inbound media frame. An async Redis GET/SET per frame would
 *      add real-time latency and blow out the Upstash request budget.
 *   4. If the instance dies mid-call the WebSocket drops and Twilio
 *      hangs up; rehydrating session state on another instance
 *      wouldn't save the call anyway.
 *
 * For things that *do* need cross-instance state — rate limits,
 * idempotency keys, a future active-call-to-instance index for
 * dashboard or kill-switch use cases — use `src/services/kv.ts`
 * instead. That's what the KV abstraction is for.
 *
 * Horizontal scaling of the WS tier works fine without shared session
 * state: run N WS instances behind a load balancer, each one handles
 * whichever calls it happens to receive, Redis is only consulted for
 * the few things that genuinely need cross-instance coordination.
 */

import type { CallSession, CoTrackProRole } from "../types/index.js";
import { getVoiceId } from "../config/voices.js";
import { logger } from "./logger.js";

// Sessions with no activity for this long are considered zombies (15 min)
const SESSION_TTL_MS = 15 * 60 * 1000;
// Absolute max call duration before forced cleanup (2 hours)
const MAX_CALL_DURATION_MS = 2 * 60 * 60 * 1000;
// How often to sweep for stale sessions
const SWEEP_INTERVAL_MS = 60 * 1000;

const sessions = new Map<string, CallSession>();
// Reverse index: streamSid → callSid for O(1) lookup
const streamIndex = new Map<string, string>();
// Callbacks invoked when a session is force-reaped (so the call handler can clean up)
const onDestroyCallbacks = new Map<string, () => void>();

export function createSession(
  callSid: string,
  streamSid: string,
  role: CoTrackProRole = "parent",
): CallSession {
  const now = Date.now();
  const session: CallSession = {
    callSid,
    streamSid,
    role,
    voiceId: getVoiceId(role),
    conversationHistory: [],
    isProcessing: false,
    audioBuffer: [],
    silenceStartMs: null,
    createdAt: now,
    lastActivityMs: now,
    costMetrics: {
      claudeInputTokens: 0,
      claudeOutputTokens: 0,
      claudeCacheCreationTokens: 0,
      claudeCacheReadTokens: 0,
      ttsChars: 0,
      ttsCharsCached: 0,
      sttSecs: 0,
    },
  };
  sessions.set(callSid, session);
  streamIndex.set(streamSid, callSid);
  logger.info({ callSid, role, streamSid }, "Session created");
  return session;
}

/** Update last-activity timestamp (call from audio hot path) */
export function touchSession(callSid: string): void {
  const session = sessions.get(callSid);
  if (session) session.lastActivityMs = Date.now();
}

/** Register a callback to invoke when a session is force-reaped by the TTL sweep */
export function onSessionDestroy(callSid: string, cb: () => void): void {
  onDestroyCallbacks.set(callSid, cb);
}

export function getSession(callSid: string): CallSession | undefined {
  return sessions.get(callSid);
}

export function getSessionByStream(streamSid: string): CallSession | undefined {
  const callSid = streamIndex.get(streamSid);
  return callSid ? sessions.get(callSid) : undefined;
}

export function destroySession(callSid: string): void {
  const session = sessions.get(callSid);
  if (session) {
    streamIndex.delete(session.streamSid);
  }
  sessions.delete(callSid);
  onDestroyCallbacks.delete(callSid);
  logger.info({ callSid }, "Session destroyed");
}

export function sessionCount(): number {
  return sessions.size;
}

/** Return all active sessions (for graceful shutdown draining) */
export function allSessions(): CallSession[] {
  return Array.from(sessions.values());
}

// ── Periodic sweep for zombie / over-limit sessions ─────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [callSid, session] of sessions) {
    const idle = now - session.lastActivityMs;
    const age = now - session.createdAt;

    if (idle > SESSION_TTL_MS) {
      logger.warn({ callSid, idleMs: idle }, "Reaping zombie session (idle TTL)");
      const cb = onDestroyCallbacks.get(callSid);
      if (cb) cb();
      destroySession(callSid);
    } else if (age > MAX_CALL_DURATION_MS) {
      logger.warn({ callSid, ageMs: age }, "Reaping session (max call duration)");
      const cb = onDestroyCallbacks.get(callSid);
      if (cb) cb();
      destroySession(callSid);
    }
  }
}, SWEEP_INTERVAL_MS).unref(); // unref so the timer doesn't prevent process exit
