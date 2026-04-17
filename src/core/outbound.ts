/**
 * core/outbound.ts — Framework-agnostic outbound-call initiation.
 *
 * Creates an outbound Twilio call that connects to the same
 * bidirectional WebSocket stream as inbound calls. Called from both
 * the Fastify handler and the Vercel serverless handler.
 */

import twilio from "twilio";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { buildOutboundTwiml } from "./twiml.js";
import { checkRateLimit, hashClientKey } from "./rateLimit.js";
import { bearerMatches } from "./auth.js";
import { validateDialable } from "./phoneValidation.js";
import { normalizeRole } from "./enumValidation.js";
import {
  lookupIdempotent,
  parseIdempotencyKey,
  storeIdempotent,
} from "./idempotency.js";

const log = logger.child({ core: "outbound" });

// Singleton Twilio client — avoids recreating on every outbound call.
// On Vercel this is created once per serverless instance and reused
// across warm invocations.
const twilioClient = twilio(env.twilioAccountSid, env.twilioAuthToken);

export type OutboundRequest = {
  to?: string;
  role?: string;
};

/**
 * Discriminated union for outbound-call results.
 *
 * Previously this was a single error variant with
 * `body: { error; details?; retryAfterSeconds? }`, which was too
 * permissive: every error status permitted every optional field,
 * even though `retryAfterSeconds` only makes sense on 429 and
 * `details` isn't used on 401. L-1 in the code review called this
 * out as "missed opportunity for a discriminated union."
 *
 * The variants below narrow each status to exactly the fields it
 * actually populates:
 *
 *   - `OutboundSuccess`     — 200: happy path, `headers` optional
 *                             (X-Idempotent-Replay when applicable).
 *   - `OutboundBadRequest`  — 400: validation failures (missing
 *                             `to`, non-E.164, disallowed country,
 *                             malformed Idempotency-Key). `details`
 *                             is optional because the "missing 'to'"
 *                             path doesn't set one.
 *   - `OutboundUnauthorized`— 401: Bearer token missing or wrong.
 *                             Just `{ error }`.
 *   - `OutboundRateLimited` — 429: retry-after is REQUIRED so that
 *                             callers who check `status === 429` can
 *                             trust the field is present without
 *                             optional chaining.
 *   - `OutboundServerError` — 500: transient Twilio REST failure.
 *
 * `IdempotencyKeyError` from `core/idempotency.ts` has a
 * `{ ok: false; status: 400; body: { error; details } }` shape that
 * is a width-subtype of `OutboundBadRequest` (required `details` is
 * assignable to optional `details`), so the `return keyParse;`
 * short-circuit in `initiateOutboundCall` still typechecks.
 */

export type OutboundSuccess = {
  ok: true;
  status: 200;
  body: {
    success: true;
    callSid: string;
    to: string;
    role: string;
  };
  /** Optional headers the adapter should set (e.g. X-Idempotent-Replay). */
  headers?: Record<string, string>;
};

export type OutboundBadRequest = {
  ok: false;
  status: 400;
  body: {
    error: string;
    details?: string;
  };
  headers?: Record<string, string>;
};

export type OutboundUnauthorized = {
  ok: false;
  status: 401;
  body: {
    error: string;
  };
  headers?: Record<string, string>;
};

export type OutboundRateLimited = {
  ok: false;
  status: 429;
  body: {
    error: string;
    details?: string;
    /** Seconds until the client may retry. REQUIRED — this is the
     *  discrimination payoff: callers who check status === 429 can
     *  trust the field without optional chaining. */
    retryAfterSeconds: number;
  };
  /** Adapter MUST set Retry-After from this result. */
  headers: Record<string, string>;
};

export type OutboundServerError = {
  ok: false;
  status: 500;
  body: {
    error: string;
    details?: string;
  };
  headers?: Record<string, string>;
};

export type OutboundResult =
  | OutboundSuccess
  | OutboundBadRequest
  | OutboundUnauthorized
  | OutboundRateLimited
  | OutboundServerError;

/**
 * Authorize an outbound request using the Bearer token in the
 * Authorization header. Returns null on success, or an OutboundResult
 * error to return to the caller.
 *
 * Comparison is timing-safe via `bearerMatches` to avoid leaking the
 * token via a character-by-character side channel (see C-2 in
 * docs/CODE_REVIEW-vercel-hosting-optimization.md).
 */
export async function authorizeOutbound(
  authHeader: string | undefined,
): Promise<{ result: OutboundResult | null; userId?: string }> {
  if (!env.outboundApiKey && !env.clerkSecretKey) {
    // Fail closed in production. An unauth'd /call/outbound is a direct
    // path to billing fraud (a leaked URL → unbounded Twilio dials).
    // Mirrors the cron-handler pattern in api/cron/cost-rollup.ts.
    if (env.nodeEnv === "production") {
      log.error(
        "Both OUTBOUND_API_KEY and CLERK_SECRET_KEY are unset in production — refusing to authorize outbound calls.",
      );
      return {
        result: {
          ok: false,
          status: 500,
          body: {
            error: "Server misconfigured",
            details: "OUTBOUND_API_KEY or CLERK_SECRET_KEY is required in production",
          },
        },
      };
    }
    return { result: null }; // auth disabled (non-prod escape hatch)
  }

  // Try Clerk JWT first (browser-based sub-app calls)
  const { verifyClerkToken } = await import("./clerkAuth.js");
  const clerk = await verifyClerkToken(authHeader);
  if (clerk.authenticated) {
    return { result: null, userId: clerk.userId };
  }

  // Fall back to API key
  if (!env.outboundApiKey) return { result: null };
  if (!bearerMatches(authHeader, env.outboundApiKey)) {
    return { result: { ok: false, status: 401, body: { error: "Unauthorized" } } };
  }
  return { result: null };
}

/**
 * Rate-limit check keyed on the caller's API key (hashed). When the
 * Bearer token isn't set we key on a literal "anonymous" bucket, so
 * unauth'd local dev still gets a single shared budget — useful when
 * testing and not harmful in prod (prod always has the Bearer token).
 */
export async function checkOutboundRateLimit(
  authHeader: string | undefined,
): Promise<OutboundResult | null> {
  // Caller identity for rate-limit bucketing. Hash so the KV key
  // doesn't contain the raw secret.
  const rawKey = env.outboundApiKey
    ? (authHeader?.replace(/^Bearer\s+/i, "") ?? "anonymous")
    : "anonymous";
  const clientKey = hashClientKey(rawKey);

  const result = await checkRateLimit(clientKey, "outbound", {
    perMinute: env.outboundRateLimitPerMin,
    perHour: env.outboundRateLimitPerHour,
  });

  if (result.allowed) return null;

  const retryAfterSeconds = result.resetAt
    ? Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
    : 60;

  log.warn(
    {
      clientKey,
      limitedBy: result.limitedBy,
      counts: result.counts,
      retryAfterSeconds,
    },
    "Outbound call rate-limited",
  );

  return {
    ok: false,
    status: 429,
    body: {
      error: "Too many requests",
      details: `Rate limit exceeded (${result.limitedBy} window)`,
      retryAfterSeconds,
    },
    headers: { "Retry-After": String(retryAfterSeconds) },
  };
}

/**
 * Initiate an outbound call. Validates input, authorizes, then calls
 * the Twilio REST API. Returns a structured result the caller
 * (Fastify or Vercel) maps to its HTTP response.
 *
 * When `idempotencyKeyHeader` is provided, the result of the first
 * successful-or-deterministically-failed call with that key is cached
 * for 24 hours. Subsequent calls with the same key return the cached
 * response with `X-Idempotent-Replay: true` and never touch Twilio.
 * This closes the double-dial window on network-retry. See M-3 in
 * docs/CODE_REVIEW-vercel-hosting-optimization.md.
 *
 * Transient server errors (500 from our side, including Twilio REST
 * failures) are NOT cached — the whole point of retries is to get
 * past a transient failure, and cached-500 would defeat that.
 */
export async function initiateOutboundCall(
  body: OutboundRequest | undefined,
  idempotencyKeyHeader?: string | string[],
): Promise<OutboundResult> {
  // Parse + validate the Idempotency-Key header first. A malformed
  // header short-circuits to 400 — we don't silently drop it, because
  // a client that asked for idempotency and got it ignored would be
  // a bug waiting to happen.
  const keyParse = parseIdempotencyKey(idempotencyKeyHeader);
  if (!keyParse.ok) return keyParse;
  const idempotencyHash = keyParse.key;

  // Cache lookup. Hit → return cached result with X-Idempotent-Replay.
  // Miss → proceed with the real work.
  const lookup = await lookupIdempotent<OutboundResult>(
    "outbound",
    idempotencyHash,
  );
  if (lookup.hit) {
    log.info({ idempotencyHash }, "Outbound call idempotent replay");
    // Defensive clone + add replay header. We don't mutate the cached
    // value because the KV MemoryKv backend shares the object
    // reference across reads.
    const cached = lookup.cachedValue;
    return {
      ...cached,
      headers: {
        ...(cached.headers ?? {}),
        "X-Idempotent-Replay": "true",
      },
    } as OutboundResult;
  }

  if (!body?.to) {
    return {
      ok: false,
      status: 400,
      body: { error: "Missing 'to' phone number" },
    };
  }

  // C-1: validate the phone number format and country code BEFORE
  // handing it to Twilio. A leaked Bearer token could otherwise dial
  // premium-rate international numbers and run up a bill before the
  // per-hour rate limit trips. See src/core/phoneValidation.ts.
  const phoneCheck = validateDialable(body.to);
  if (!phoneCheck.ok) {
    log.warn(
      { to: body.to, reason: phoneCheck.reason },
      "Outbound call rejected — phone number failed validation",
    );
    const result: OutboundResult = {
      ok: false,
      status: 400,
      body: {
        error: "Invalid destination phone number",
        details: phoneCheck.detail,
      },
    };
    // Cache the deterministic 400 — same bad input will always fail
    // the same way, and we don't want retries to burn rate-limit
    // budget re-validating.
    await storeIdempotent("outbound", idempotencyHash, result);
    return result;
  }

  // Validate role is a known CoTrackPro persona (H-2/H-3 in the code
  // review). An unknown role would propagate into getVoiceId() and
  // may fall back or crash — normalizeRole logs and returns "parent".
  const role = normalizeRole(body.role);
  const to = body.to;
  const twimlStr = buildOutboundTwiml({ role });

  try {
    const call = await twilioClient.calls.create({
      to,
      from: env.twilioPhoneNumber,
      twiml: twimlStr,
      statusCallback: `https://${env.apiDomain}/call/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    log.info({ callSid: call.sid, to, role }, "Outbound call initiated");

    const result: OutboundResult = {
      ok: true,
      status: 200,
      body: {
        success: true,
        callSid: call.sid,
        to,
        role,
      },
      headers: idempotencyHash
        ? { "X-Idempotent-Replay": "false" }
        : undefined,
    };
    // Cache the success so a retry of the same idempotency key
    // returns the same callSid instead of dialing again.
    await storeIdempotent("outbound", idempotencyHash, result);
    return result;
  } catch (err) {
    log.error({ err, to }, "Failed to initiate outbound call");
    // Deliberately NOT cached — transient Twilio errors should be
    // retryable. Caching the 500 would break the retry story.
    return {
      ok: false,
      status: 500,
      body: {
        error: "Failed to initiate call",
        details: err instanceof Error ? err.message : "unknown",
      },
    };
  }
}
