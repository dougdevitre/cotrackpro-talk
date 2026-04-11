/**
 * handlers/twiml.ts — Twilio webhook handlers (Fastify adapter)
 *
 * Thin Fastify wrapper around the framework-agnostic core in
 * src/core/twiml.ts. The same core is reused by the Vercel serverless
 * handlers in api/call/*.ts.
 *
 * /call/incoming  — POST webhook Twilio hits when a call comes in.
 *                   Returns TwiML with <Connect><Stream> to open
 *                   a bidirectional WebSocket back to the WS host.
 *
 * /call/status    — POST webhook for call status callbacks (optional).
 */

import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import {
  buildIncomingTwiml,
  logIncomingCall,
  logStatusCallback,
  signatureValidationEnabled,
  validateTwilioSignature,
} from "../core/twiml.js";

const log = logger.child({ handler: "twiml" });

export function registerTwimlRoutes(app: FastifyInstance): void {
  // ── Twilio signature validation hook ───────────────────────────────────
  if (signatureValidationEnabled()) {
    log.info("Twilio webhook signature validation enabled");
  }

  app.addHook("preHandler", async (request, reply) => {
    if (!signatureValidationEnabled()) return;
    if (request.method !== "POST") return;
    if (
      !request.url.startsWith("/call/incoming") &&
      !request.url.startsWith("/call/status")
    ) {
      return;
    }

    const signature = request.headers["x-twilio-signature"] as string | undefined;
    // Use apiDomain here — Twilio signs against the exact public URL it
    // hit, which is the HTTP host (Vercel in hybrid, or serverDomain in
    // single-host, both of which resolve to apiDomain).
    const fullUrl = `https://${env.apiDomain}${request.url}`;
    const params = (request.body as Record<string, string>) ?? {};

    if (!validateTwilioSignature(signature, fullUrl, params)) {
      return reply.status(403).send("Forbidden");
    }
  });

  /**
   * Twilio calls this URL when a call arrives on your phone number.
   * We return TwiML that starts a bidirectional media stream to the
   * WS host.
   */
  app.post("/call/incoming", async (request, reply) => {
    const body = request.body as Record<string, string> | undefined;
    const { from } = logIncomingCall(body);

    const role = (request.query as Record<string, string>)?.role ?? "parent";
    const twiml = buildIncomingTwiml({ role, callerNumber: from });

    reply.type("text/xml").send(twiml);
  });

  /**
   * Optional: Twilio status callback for call lifecycle events.
   * Useful for logging, analytics, and cleanup.
   */
  app.post("/call/status", async (request, reply) => {
    logStatusCallback(request.body as Record<string, string> | undefined);
    reply.status(204).send();
  });
}
