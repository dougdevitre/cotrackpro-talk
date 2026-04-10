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
// Reverse index: streamSid → callSid for O(1) lookup
const streamIndex = new Map<string, string>();

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
  streamIndex.set(streamSid, callSid);
  logger.info({ callSid, role, streamSid }, "Session created");
  return session;
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
  logger.info({ callSid }, "Session destroyed");
}

export function sessionCount(): number {
  return sessions.size;
}
