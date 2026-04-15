/**
 * core/ai.ts — Framework-agnostic AI completion proxy for sub-apps.
 *
 * Sub-apps (*.cotrackpro.com) used to call @google/genai directly from the
 * browser, shipping an API key to every user. This proxies Anthropic through
 * our own server so the key stays server-side and all AI spend is auditable
 * per-user.
 *
 * Auth: Clerk JWT required. No API-key fallback — sub-apps only ever hold
 * the Clerk publishable key, never a raw API key.
 *
 * Rate-limited per userId (shared budget across all sub-apps a user uses)
 * via the existing KV rate limiter.
 */

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { verifyClerkToken } from "./clerkAuth.js";
import { checkRateLimit, hashClientKey } from "./rateLimit.js";

const log = logger.child({ core: "ai" });

// Reuse a singleton client. `anthropic.ts` has its own for the voice
// pipeline; the proxy keeps a separate instance so stream-specific
// defaults there don't bleed into general-purpose completions.
const client = new Anthropic({ apiKey: env.anthropicApiKey });

// Hard caps. Sub-apps have no reason to request long outputs; capping
// here protects against cost blow-ups from a compromised browser.
const MAX_TOKENS_CAP = 4096;
const MAX_TOKENS_DEFAULT = 1024;
const MAX_MESSAGES = 60;
const MAX_CONTENT_CHARS = 200_000; // ~50k tokens of input, generous

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiCompleteRequest {
  messages?: unknown;
  system?: unknown;
  model?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  app?: unknown;
}

export type AiCompleteResult =
  | {
      ok: true;
      status: 200;
      body: {
        text: string;
        model: string;
        stop_reason: string | null;
        usage: {
          input_tokens: number;
          output_tokens: number;
        };
      };
    }
  | {
      ok: false;
      status: 400 | 401 | 413 | 429 | 500 | 502;
      body: { error: string; details?: string; retryAfterSeconds?: number };
      headers?: Record<string, string>;
    };

/**
 * Authenticate the request via Clerk JWT. Returns the userId on success,
 * or an error result the caller should send back.
 */
export async function authorizeAi(
  authHeader: string | undefined,
): Promise<{ userId?: string; error?: AiCompleteResult }> {
  if (!env.clerkSecretKey) {
    return {
      error: {
        ok: false,
        status: 500,
        body: {
          error: "AI proxy not configured",
          details: "CLERK_SECRET_KEY not set on the server",
        },
      },
    };
  }
  const result = await verifyClerkToken(authHeader);
  if (!result.authenticated || !result.userId) {
    return {
      error: {
        ok: false,
        status: 401,
        body: { error: "Unauthorized", details: "Valid Clerk JWT required" },
      },
    };
  }
  return { userId: result.userId };
}

/**
 * Per-user rate limit. Budget is shared across every sub-app the user
 * touches — a single compromised sub-app can't amplify abuse.
 */
export async function checkAiRateLimit(
  userId: string,
): Promise<AiCompleteResult | null> {
  const clientKey = hashClientKey(userId);
  const result = await checkRateLimit(clientKey, "ai", {
    perMinute: env.aiRateLimitPerMin,
    perHour: env.aiRateLimitPerHour,
  });
  if (result.allowed) return null;

  const retryAfterSeconds = result.resetAt
    ? Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
    : 60;

  log.warn(
    { userId, limitedBy: result.limitedBy, counts: result.counts },
    "AI proxy rate-limited",
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

function validate(body: AiCompleteRequest | undefined): {
  ok: true;
  messages: AiMessage[];
  system?: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  app?: string;
} | { ok: false; error: AiCompleteResult } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: {
        ok: false,
        status: 400,
        body: { error: "Invalid body", details: "Expected JSON object" },
      },
    };
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      ok: false,
      error: {
        ok: false,
        status: 400,
        body: { error: "messages required", details: "Non-empty array" },
      },
    };
  }
  if (messages.length > MAX_MESSAGES) {
    return {
      ok: false,
      error: {
        ok: false,
        status: 413,
        body: { error: "messages too long", details: `Max ${MAX_MESSAGES} turns` },
      },
    };
  }

  const cleaned: AiMessage[] = [];
  let totalChars = 0;
  for (const m of messages) {
    if (
      !m || typeof m !== "object" ||
      (m as AiMessage).role !== "user" && (m as AiMessage).role !== "assistant" ||
      typeof (m as AiMessage).content !== "string"
    ) {
      return {
        ok: false,
        error: {
          ok: false,
          status: 400,
          body: { error: "Invalid message", details: "Each must be { role, content:string }" },
        },
      };
    }
    totalChars += (m as AiMessage).content.length;
    cleaned.push({ role: (m as AiMessage).role, content: (m as AiMessage).content });
  }
  if (totalChars > MAX_CONTENT_CHARS) {
    return {
      ok: false,
      error: {
        ok: false,
        status: 413,
        body: { error: "content too large", details: `Max ${MAX_CONTENT_CHARS} chars` },
      },
    };
  }
  if (cleaned[0].role !== "user") {
    return {
      ok: false,
      error: {
        ok: false,
        status: 400,
        body: { error: "first message must be user" },
      },
    };
  }

  const system = typeof body.system === "string" ? body.system : undefined;
  const model = typeof body.model === "string" && body.model.length > 0
    ? body.model
    : env.anthropicModel;
  const maxTokens = Math.min(
    MAX_TOKENS_CAP,
    typeof body.max_tokens === "number" && body.max_tokens > 0
      ? Math.floor(body.max_tokens)
      : MAX_TOKENS_DEFAULT,
  );
  const temperature = typeof body.temperature === "number"
    ? Math.max(0, Math.min(1, body.temperature))
    : undefined;
  const app = typeof body.app === "string" ? body.app.slice(0, 64) : undefined;

  return { ok: true, messages: cleaned, system, model, maxTokens, temperature, app };
}

export async function completeAi(
  authHeader: string | undefined,
  body: AiCompleteRequest | undefined,
): Promise<AiCompleteResult> {
  const { userId, error: authError } = await authorizeAi(authHeader);
  if (authError) return authError;

  const rate = await checkAiRateLimit(userId!);
  if (rate) return rate;

  const v = validate(body);
  if (!v.ok) return v.error;

  try {
    const msg = await client.messages.create({
      model: v.model,
      max_tokens: v.maxTokens,
      ...(v.system ? { system: v.system } : {}),
      ...(v.temperature !== undefined ? { temperature: v.temperature } : {}),
      messages: v.messages,
    });

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    log.info(
      {
        userId,
        app: v.app,
        model: v.model,
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
      },
      "ai.complete",
    );

    return {
      ok: true,
      status: 200,
      body: {
        text,
        model: msg.model,
        stop_reason: msg.stop_reason,
        usage: {
          input_tokens: msg.usage.input_tokens,
          output_tokens: msg.usage.output_tokens,
        },
      },
    };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    const upstreamStatus = typeof e.status === "number" ? e.status : undefined;
    log.error({ err, userId, app: v.app }, "ai.complete.error");
    if (upstreamStatus === 429) {
      return {
        ok: false,
        status: 429,
        body: { error: "Upstream rate limit", details: "Anthropic 429", retryAfterSeconds: 30 },
        headers: { "Retry-After": "30" },
      };
    }
    return {
      ok: false,
      status: 502,
      body: { error: "Upstream error", details: e.message ?? "Anthropic call failed" },
    };
  }
}
