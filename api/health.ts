/**
 * api/health.ts — Vercel serverless health check.
 *
 * GET /health — Returns { status: "ok", uptime } from the Vercel
 * function instance. This is a lightweight liveness probe for the
 * HTTP tier.
 *
 * NOTE: `activeCalls` is NOT returned here because active calls live
 * on the long-running WS host, not on the serverless HTTP tier. If you
 * need that, hit the /health endpoint on WS_DOMAIN instead (served by
 * src/index.ts on the Fastify server).
 */

import type { IncomingMessage, ServerResponse } from "http";
import { requireMethod, sendJson } from "../src/core/httpAdapter.js";

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!requireMethod(req, res, "GET")) return;
  sendJson(res, 200, {
    status: "ok",
    tier: "api",
    uptime: process.uptime(),
  });
}
