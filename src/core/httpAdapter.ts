/**
 * core/httpAdapter.ts — Tiny Node HTTP helpers for the Vercel handlers.
 *
 * Vercel's Node runtime passes standard http.IncomingMessage /
 * http.ServerResponse objects to each function. These helpers parse
 * request bodies and query strings so the Vercel adapters in api/*.ts
 * can stay thin and call into src/core/ with plain objects.
 *
 * Not dependent on the Fastify types — pure Node.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { resolveRequestId } from "./requestId.js";

/** Read the raw request body as a UTF-8 string. */
export function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Parse the body based on Content-Type. Returns an empty object on
 * missing body or unknown type. Twilio webhooks use
 * application/x-www-form-urlencoded; our own REST endpoints use JSON.
 */
export async function parseBody(
  req: IncomingMessage,
): Promise<Record<string, string>> {
  const contentType = (req.headers["content-type"] || "").toLowerCase();
  const raw = await readRawBody(req);
  if (!raw) return {};

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    const out: Record<string, string> = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }

  return {};
}

/** Parse a query string into a plain object. Last value wins on dupes. */
export function parseQuery(
  req: IncomingMessage,
): Record<string, string> {
  const url = req.url || "";
  const q = url.indexOf("?");
  if (q < 0) return {};
  const params = new URLSearchParams(url.slice(q + 1));
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

/** Send a JSON response with the given status code. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** Send an XML response with the given status code. */
export function sendXml(
  res: ServerResponse,
  status: number,
  body: string,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/xml; charset=utf-8");
  res.end(body);
}

/** Send an empty response with the given status code (e.g. 204, 403). */
export function sendStatus(
  res: ServerResponse,
  status: number,
  body: string = "",
): void {
  res.statusCode = status;
  res.end(body);
}

/**
 * Guard that a request used the expected HTTP method. Responds 405 and
 * returns false if not, so the caller can early-return.
 */
export function requireMethod(
  req: IncomingMessage,
  res: ServerResponse,
  method: "GET" | "POST" | "DELETE",
): boolean {
  if (req.method === method) return true;
  res.statusCode = 405;
  res.setHeader("Allow", method);
  res.end();
  return false;
}

/**
 * Stamp a request ID on the response and return it so the handler
 * can include it in child-logger calls. Honors an inbound
 * `x-request-id` header (length + charset validated by
 * resolveRequestId) or generates a new 16-hex-char ID. Audit P-5.
 *
 * Shares the generation logic with the Fastify preHandler via
 * `src/core/requestId.ts` so there's one definition of the ID
 * format across both tiers.
 */
export function stampRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const id = resolveRequestId(req.headers["x-request-id"]);
  res.setHeader("x-request-id", id);
  return id;
}
