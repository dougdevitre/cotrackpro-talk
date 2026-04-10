/**
 * utils/logger.ts — Structured logging via pino
 */

import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.logLevel,
  transport:
    env.nodeEnv === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export function callLogger(callSid: string) {
  return logger.child({ callSid });
}
