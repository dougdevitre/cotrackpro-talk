/**
 * handlers/twiml.ts — Twilio webhook handlers
 *
 * /call/incoming  — POST webhook Twilio hits when a call comes in.
 *                   Returns TwiML with <Connect><Stream> to open
 *                   a bidirectional WebSocket back to our server.
 *
 * /call/status    — POST webhook for call status callbacks (optional).
 */

import type { FastifyInstance } from "fastify";
import twilio from "twilio";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ handler: "twiml" });

/** Escape a string for safe use in an XML attribute value. */
function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function registerTwimlRoutes(app: FastifyInstance): void {
  // ── Twilio signature validation hook ───────────────────────────────────
  const shouldValidate = env.validateTwilioSignature === "true";
  if (shouldValidate) {
    log.info("Twilio webhook signature validation enabled");
  }

  app.addHook("preHandler", async (request, reply) => {
    if (!shouldValidate) return;
    // Only validate Twilio POST webhooks
    if (request.method !== "POST") return;
    if (!request.url.startsWith("/call/incoming") && !request.url.startsWith("/call/status")) return;

    const signature = request.headers["x-twilio-signature"] as string | undefined;
    if (!signature) {
      log.warn("Missing X-Twilio-Signature header");
      return reply.status(403).send("Forbidden");
    }

    const url = `https://${env.serverDomain}${request.url}`;
    const params = (request.body as Record<string, string>) ?? {};
    const isValid = twilio.validateRequest(
      env.twilioAuthToken,
      signature,
      url,
      params,
    );

    if (!isValid) {
      log.warn({ url }, "Invalid Twilio signature");
      return reply.status(403).send("Forbidden");
    }
  });

  /**
   * Twilio calls this URL when a call arrives on your phone number.
   * We return TwiML that starts a bidirectional media stream.
   *
   * Custom parameters are passed through to the WebSocket start message,
   * so the call handler can read the role from the IVR or URL params.
   */
  app.post("/call/incoming", async (request, reply) => {
    const body = request.body as Record<string, string> | undefined;
    const from = body?.From ?? "unknown";
    const callSid = body?.CallSid ?? "unknown";

    log.info({ from, callSid }, "Incoming call");

    // Determine role — could come from query param, IVR selection, or caller lookup
    const role = (request.query as Record<string, string>)?.role ?? "parent";

    const wsUrl = `wss://${env.serverDomain}/call/stream`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXmlAttr(wsUrl)}">
      <Parameter name="role" value="${escapeXmlAttr(role)}" />
      <Parameter name="callerNumber" value="${escapeXmlAttr(from)}" />
    </Stream>
  </Connect>
</Response>`;

    reply.type("text/xml").send(twiml);
  });

  /**
   * Optional: Twilio status callback for call lifecycle events.
   * Useful for logging, analytics, and cleanup.
   */
  app.post("/call/status", async (request, reply) => {
    const body = request.body as Record<string, string> | undefined;
    log.info(
      {
        callSid: body?.CallSid,
        callStatus: body?.CallStatus,
        duration: body?.CallDuration,
      },
      "Call status update",
    );
    reply.status(204).send();
  });
}
