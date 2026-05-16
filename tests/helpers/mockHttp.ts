/**
 * tests/helpers/mockHttp.ts — Minimal Node HTTP mocks for the Vercel
 * serverless handlers. Both halves were duplicated in
 * tests/httpAdapter.test.ts before; lifted here so handler-level
 * integration tests (api/**) can reuse them without copying.
 */

import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "http";

export interface MockRequestOpts {
  url?: string;
  method?: string;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

/**
 * Build a fake IncomingMessage backed by a single-chunk Readable.
 * Chunks are emitted as UTF-8 Buffers so parseBody's
 * `Buffer.concat(chunks).toString("utf8")` behaves as it does in
 * production.
 */
export function mockRequest(opts: MockRequestOpts): IncomingMessage {
  const stream = new Readable({
    read() {
      this.push(opts.body ? Buffer.from(opts.body, "utf8") : null);
      this.push(null);
    },
  }) as unknown as IncomingMessage;

  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.contentType) headers["content-type"] = opts.contentType;

  (stream as unknown as {
    url?: string;
    method?: string;
    headers: Record<string, string>;
  }).url = opts.url;
  (stream as unknown as { method?: string }).method = opts.method;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  return stream;
}

export interface MockResponseHandle {
  res: ServerResponse;
  getStatus: () => number | undefined;
  getHeader: (name: string) => string | undefined;
  getBody: () => string;
}

/** Minimal ServerResponse stub that captures status, headers, body. */
export function mockResponse(): MockResponseHandle {
  const headers: Record<string, string> = {};
  let body = "";
  const res = {
    statusCode: undefined as number | undefined,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(payload?: string) {
      if (payload !== undefined) body += payload;
    },
  } as unknown as ServerResponse;

  return {
    res,
    getStatus: () => (res as unknown as { statusCode: number | undefined }).statusCode,
    getHeader: (name) => headers[name.toLowerCase()],
    getBody: () => body,
  };
}
