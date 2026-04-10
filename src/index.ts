/**
 * index.ts — CoTrackPro Voice Center entrypoint
 *
 * Fastify server with:
 *   - POST /call/incoming     — Twilio webhook → returns TwiML
 *   - WS   /call/stream       — Bidirectional media stream from Twilio
 *   - POST /call/outbound     — Initiate outbound calls
 *   - POST /call/status       — Call status callbacks
 *   - GET  /health            — Health check
 */

import Fastify from "fastify";
import fastifyWebSocket from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { sessionCount } from "./utils/sessions.js";
import { registerTwimlRoutes } from "./handlers/twiml.js";
import { registerOutboundRoutes } from "./handlers/outbound.js";
import { handleCallStream } from "./handlers/callHandler.js";

async function main() {
  const app = Fastify({
    logger: false, // We use our own pino logger
  });

  // ── Plugins ───────────────────────────────────────────────────────────
  await app.register(fastifyFormBody); // Parse Twilio's application/x-www-form-urlencoded
  await app.register(fastifyWebSocket);

  // ── HTTP Routes ───────────────────────────────────────────────────────
  registerTwimlRoutes(app);
  registerOutboundRoutes(app);

  // Health check
  app.get("/health", async (_req, reply) => {
    reply.send({
      status: "ok",
      activeCalls: sessionCount(),
      uptime: process.uptime(),
    });
  });

  // ── WebSocket Route (Twilio media stream) ─────────────────────────────
  app.register(async function (fastify) {
    fastify.get(
      "/call/stream",
      { websocket: true },
      (socket, _req) => {
        logger.info("New Twilio media stream WebSocket connection");
        handleCallStream(socket);
      },
    );
  });

  // ── Start ─────────────────────────────────────────────────────────────
  try {
    await app.listen({ port: env.port, host: "0.0.0.0" });
    logger.info(
      {
        port: env.port,
        domain: env.serverDomain,
        env: env.nodeEnv,
      },
      `CoTrackPro Voice Center running`,
    );
    logger.info(`  Twilio webhook:  https://${env.serverDomain}/call/incoming`);
    logger.info(`  WebSocket:       wss://${env.serverDomain}/call/stream`);
    logger.info(`  Outbound API:    https://${env.serverDomain}/call/outbound`);
    logger.info(`  Health:          https://${env.serverDomain}/health`);
  } catch (err) {
    logger.fatal({ err }, "Failed to start server");
    process.exit(1);
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
