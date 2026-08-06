/**
 * api/health.ts — Vercel serverless health check.
 *
 * GET /health — liveness probe. Returns { status, tier, uptime, kv }
 * from the Vercel function instance. Always 200: a KV misconfiguration
 * shows up in the `kv` block rather than as a failed health check, so an
 * uptime monitor doesn't page for a config problem.
 *
 * GET /health?deep=1 — adds a live KV round-trip and the backend detail,
 * and returns 503 if the backend isn't durable or the round-trip fails.
 * That status code is the point: it lets scripts/kv-setup.sh verify a
 * deploy with `curl -f` instead of parsing JSON. Requires the shared
 * bearer, because the probe WRITES a canary key and `detail` carries the
 * backend host.
 *
 * NOTE: `activeCalls` is NOT returned here because active calls live
 * on the long-running WS host, not on the serverless HTTP tier. If you
 * need that, hit the /health endpoint on WS_DOMAIN instead (served by
 * src/index.ts on the Fastify server).
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  requireMethod,
  sendJson,
  stampRequestId,
} from "../src/core/httpAdapter.js";
import { authorizeHubBearer } from "../src/core/auth.js";
import { kvHealth, wantsDeep } from "../src/core/health.js";

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  stampRequestId(req, res);
  if (!requireMethod(req, res, "GET")) return;

  const deep = wantsDeep(req.url);
  if (deep) {
    const err = authorizeHubBearer(req.headers.authorization, "health:deep");
    if (err) {
      sendJson(res, err.status, { error: err.error });
      return;
    }
  }

  const { kv, status } = await kvHealth(deep);
  sendJson(res, status, {
    // "ok" describes the function instance, which answered. Whether its
    // KV is durable is the `kv` block's job to say.
    status: "ok",
    tier: "api",
    uptime: process.uptime(),
    kv,
  });
}
