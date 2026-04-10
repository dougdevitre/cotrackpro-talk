/**
 * utils/sessions.ts — In-memory call session store
 *
 * SECURITY: Sessions are ephemeral and scoped to a single call.
 * No PII is persisted to disk. In production, consider Redis with TTL
 * if you need multi-instance session affinity.
 */

import type { CallSession, CoTrackProRole } from "../types/index.js";
import { getVoiceId } from "../config/voices.js";
import { logger } from "./logger.js";

const sessions = new Map<string, CallSession>();

export function createSession(
  callSid: string,
  streamSid: string,
  role: CoTrackProRole = "parent",
): CallSession {
  const session: CallSession = {
    callSid,
    streamSid,
    role,
    voiceId: getVoiceId(role),
    conversationHistory: [],
    isProcessing: false,
    audioBuffer: [],
    silenceStartMs: null,
    lastActivityMs: Date.now(),
  };
  sessions.set(callSid, session);
  logger.info({ callSid, role, streamSid }, "Session created");
  return session;
}

export function getSession(callSid: string): CallSession | undefined {
  return sessions.get(callSid);
}

export function getSessionByStream(streamSid: string): CallSession | undefined {
  for (const s of sessions.values()) {
    if (s.streamSid === streamSid) return s;
  }
  return undefined;
}

export function destroySession(callSid: string): void {
  sessions.delete(callSid);
  logger.info({ callSid }, "Session destroyed");
}

export function sessionCount(): number {
  return sessions.size;
}
