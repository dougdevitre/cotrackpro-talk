/**
 * core/cors.ts — Shared CORS policy for routes called by sub-apps.
 *
 * Sub-apps run on *.cotrackpro.com (custom domain) and
 * cotrackpro-*.vercel.app (Vercel preview + unmigrated prod). The AI
 * proxy lets them send a Clerk Bearer token, which means the browser's
 * Fetch spec requires an explicit allowed origin (wildcard "*" is
 * forbidden when credentials are in play). We echo the request's
 * Origin back if it matches our allow-list.
 */

const ALLOWED_SUFFIX = ".cotrackpro.com";
// Vercel-hosted sub-apps: both the project canonical (cotrackpro-<name>.vercel.app)
// and the deploy-scoped previews (cotrackpro-<name>-<hash>-<team>.vercel.app).
// Scoped to the "cotrackpro-" name prefix so this never matches arbitrary
// third-party Vercel sites.
const VERCEL_SUBAPP_RE = /^cotrackpro-[a-z0-9-]+\.vercel\.app$/;
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
    if (u.protocol !== "https:") return null;
    if (u.hostname.endsWith(ALLOWED_SUFFIX)) return origin;
    if (VERCEL_SUBAPP_RE.test(u.hostname)) return origin;
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
