/**
 * index.ts — CoTrackPro Voice Center entrypoint
 *
 * Fastify server with:
 *   - POST /call/incoming     — Twilio webhook → returns TwiML
 *   - WS   /call/stream       — Bidirectional media stream from Twilio
 *   - POST /call/outbound-interactive — Initiate interactive outbound calls
 *   - POST /call/status       — Call status callbacks
 *   - GET  /health            — Health check
 */

import Fastify from "fastify";
import fastifyWebSocket from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { peakSessionCount, sessionCount } from "./utils/sessions.js";
import { registerTwimlRoutes } from "./handlers/twiml.js";
import { registerOutboundRoutes } from "./handlers/outbound.js";
import { registerRecordRoutes } from "./handlers/records.js";
import { registerAiRoutes } from "./handlers/ai.js";
import { registerSmsRoutes } from "./handlers/sms.js";
import { handleCallStream } from "./handlers/callHandler.js";
import { resolveRequestId } from "./core/requestId.js";
import { authorizeHubBearer } from "./core/auth.js";
import { kvHealth, wantsDeep } from "./core/health.js";

async function main() {
  const app = Fastify({
    logger: false, // We use our own pino logger
  });

  // ── Plugins ───────────────────────────────────────────────────────────
  await app.register(fastifyFormBody); // Parse Twilio's application/x-www-form-urlencoded
  await app.register(fastifyWebSocket);

  // ── Request ID stamp (audit P-5) ──────────────────────────────────────
  // Every HTTP request gets a short random ID exposed via the
  // `x-request-id` response header. If the caller provides one we
  // honor it (subject to length / charset validation in
  // resolveRequestId). The ID is attached to the request context so
  // handlers can forward it into child loggers.
  app.addHook("onRequest", async (request, reply) => {
    const id = resolveRequestId(request.headers["x-request-id"]);
    (request as typeof request & { requestId: string }).requestId = id;
    reply.header("x-request-id", id);
  });

  // ── HTTP Routes ───────────────────────────────────────────────────────
  registerTwimlRoutes(app);
  registerOutboundRoutes(app);
  registerRecordRoutes(app);
  registerAiRoutes(app);
  registerSmsRoutes(app);

  // Health check — includes peak session count so operators can see
  // how close we've been to the concurrent-session cap (audit E-2), and
  // the KV backend so a deploy running on non-durable in-memory state is
  // visible from outside. `?deep=1` adds a live KV round-trip and
  // answers 503 if it fails; it needs the shared bearer because the
  // probe writes. Same shape as the Vercel tier — see src/core/health.ts.
  app.get("/health", async (request, reply) => {
    const deep = wantsDeep(request.url);
    if (deep) {
      const err = authorizeHubBearer(request.headers.authorization, "health:deep");
      if (err) {
        reply.code(err.status).send({ error: err.error });
        return;
      }
    }

    const { kv, status } = await kvHealth(deep);
    reply.code(status).send({
      status: "ok",
      activeCalls: sessionCount(),
      peakActiveCalls: peakSessionCount(),
      maxConcurrentSessions: env.maxConcurrentSessions,
      uptime: process.uptime(),
      kv,
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
  //
  // In single-host mode (SERVER_DOMAIN set, no API_DOMAIN/WS_DOMAIN) this
  // process serves everything — HTTP routes + WebSocket — from one host.
  //
  // In hybrid mode (API_DOMAIN on Vercel + WS_DOMAIN on a long-running
  // host) this process's primary role is the WebSocket at /call/stream;
  // the HTTP routes remain registered for /health and as an optional
  // fallback, but Twilio should be pointed at API_DOMAIN for webhooks.
  const isHybrid = env.apiDomain !== env.wsDomain;

  try {
    await app.listen({ port: env.port, host: "0.0.0.0" });
    logger.info(
      {
        port: env.port,
        apiDomain: env.apiDomain,
        wsDomain: env.wsDomain,
        mode: isHybrid ? "hybrid (Vercel + WS host)" : "single host",
        env: env.nodeEnv,
      },
      `CoTrackPro Voice Center running`,
    );
    logger.info(`  WebSocket:       wss://${env.wsDomain}/call/stream`);
    logger.info(`  Twilio webhook:  https://${env.apiDomain}/call/incoming`);
    logger.info(`  Outbound (intr): https://${env.wsDomain}/call/outbound-interactive`);
    logger.info(`  Records API:     https://${env.apiDomain}/records`);
    logger.info(`  Health (WS):     https://${env.wsDomain}/health`);
    if (isHybrid) {
      logger.info(`  Health (API):    https://${env.apiDomain}/health (Vercel)`);
    }
    logger.info(`  DynamoDB:        ${env.dynamoEnabled === "true" ? "enabled" : "disabled"}`);
  } catch (err) {
    logger.fatal({ err }, "Failed to start server");
    process.exit(1);
  }

  // ── Graceful shutdown with call draining ───────────────────────────────
  const DRAIN_TIMEOUT_MS = 30_000; // Max time to wait for active calls

  const shutdown = async (signal: string) => {
    logger.info({ signal, activeCalls: sessionCount() }, "Shutting down — draining active calls");

    // Stop accepting new connections immediately
    await app.close();

    // Wait for active calls to finish (up to DRAIN_TIMEOUT_MS)
    if (sessionCount() > 0) {
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (sessionCount() === 0 || Date.now() > deadline) {
            clearInterval(check);
            if (sessionCount() > 0) {
              logger.warn(
                { remaining: sessionCount() },
                "Drain timeout — forcing shutdown with active calls",
              );
            }
            resolve();
          }
        }, 500);
      });
    }

    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
