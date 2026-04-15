/**
 * core/cors.ts — Shared CORS policy for routes called by sub-apps.
 *
 * Sub-apps run on *.cotrackpro.com. The AI proxy lets them send a Clerk
 * Bearer token, which means the browser's Fetch spec requires an explicit
 * allowed origin (wildcard "*" is forbidden when credentials are in play).
 * We echo the request's Origin back if it matches our allow-list.
 */

const ALLOWED_SUFFIX = ".cotrackpro.com";
const ALLOWED_EXACT = new Set<string>([
  "https://cotrackpro.com",
  "http://localhost:3000",
  "http://localhost:5173",
]);

export function resolveAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  if (ALLOWED_EXACT.has(origin)) return origin;
  try {
    const u = new URL(origin);
    if (u.protocol === "https:" && u.hostname.endsWith(ALLOWED_SUFFIX)) {
      return origin;
    }
  } catch {
    return null;
  }
  return null;
}

export function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = resolveAllowedOrigin(origin);
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
