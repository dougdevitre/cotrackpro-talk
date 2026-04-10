/**
 * handlers/outbound.ts — Outbound call initiation
 *
 * POST /call/outbound
 *   body: { to: "+15551234567", role?: "parent" }
 *
 * Creates an outbound Twilio call that connects to the same
 * bidirectional WebSocket stream as inbound calls.
 */

import type { FastifyInstance } from "fastify";
import twilio from "twilio";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ handler: "outbound" });

// Singleton Twilio client — avoids recreating on every outbound call
const twilioClient = twilio(env.twilioAccountSid, env.twilioAuthToken);

/** Escape a string for safe use in an XML attribute value. */
function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function registerOutboundRoutes(app: FastifyInstance): void {
  app.post("/call/outbound", async (request, reply) => {
    // Require Bearer token when OUTBOUND_API_KEY is configured
    if (env.outboundApiKey) {
      const auth = request.headers.authorization;
      if (!auth || auth !== `Bearer ${env.outboundApiKey}`) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    }

    const body = request.body as { to?: string; role?: string } | undefined;

    if (!body?.to) {
      return reply.status(400).send({ error: "Missing 'to' phone number" });
    }

    const to = body.to;
    const role = body.role ?? "parent";
    const wsUrl = `wss://${env.serverDomain}/call/stream`;

    const twimlStr = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXmlAttr(wsUrl)}">
      <Parameter name="role" value="${escapeXmlAttr(role)}" />
      <Parameter name="direction" value="outbound" />
    </Stream>
  </Connect>
</Response>`;

    try {
      const call = await twilioClient.calls.create({
        to,
        from: env.twilioPhoneNumber,
        twiml: twimlStr,
        statusCallback: `https://${env.serverDomain}/call/status`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });

      log.info({ callSid: call.sid, to, role }, "Outbound call initiated");

      return reply.send({
        success: true,
        callSid: call.sid,
        to,
        role,
      });
    } catch (err) {
      log.error({ err, to }, "Failed to initiate outbound call");
      return reply.status(500).send({
        error: "Failed to initiate call",
        details: err instanceof Error ? err.message : "unknown",
      });
    }
  });
}
