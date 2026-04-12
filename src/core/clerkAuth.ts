/**
 * core/clerkAuth.ts — Clerk JWT verification for user-facing routes.
 *
 * Verifies Clerk-issued JWTs so that browser-based CoTrackPro sub-apps
 * can call the voice API with the same Clerk session they use everywhere
 * else. Works alongside the existing API key auth — either method is
 * accepted on user-facing routes.
 *
 * Clerk JWTs are verified using the JWKS endpoint (no secret key needed
 * for verification — only the publishable key to locate the JWKS).
 */

import { verifyToken } from "@clerk/backend";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ core: "clerkAuth" });

export interface ClerkAuthResult {
  authenticated: boolean;
  userId?: string;
}

/**
 * Attempt to verify a Bearer token as a Clerk JWT.
 *
 * Returns `{ authenticated: true, userId }` on success, or
 * `{ authenticated: false }` if the token is not a valid Clerk JWT
 * (in which case the caller should fall back to API key auth).
 */
export async function verifyClerkToken(
  authHeader: string | undefined,
): Promise<ClerkAuthResult> {
  if (!env.clerkPublishableKey || !env.clerkSecretKey) {
    return { authenticated: false };
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return { authenticated: false };
  }

  const token = authHeader.slice("Bearer ".length);

  // Clerk JWTs are standard JWTs (3 dot-separated base64 segments).
  // API keys are opaque strings. Quick check to avoid hitting the JWKS
  // endpoint for obviously-not-JWT tokens.
  if (token.split(".").length !== 3) {
    return { authenticated: false };
  }

  try {
    const payload = await verifyToken(token, {
      secretKey: env.clerkSecretKey,
    });

    log.info({ userId: payload.sub }, "Clerk JWT verified");
    return { authenticated: true, userId: payload.sub };
  } catch {
    // Not a valid Clerk JWT — fall through to API key auth
    return { authenticated: false };
  }
}
