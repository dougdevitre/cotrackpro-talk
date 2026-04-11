/**
 * tests/httpAdapter.test.ts — Tests for the Node HTTP helpers used
 * by the Vercel serverless handlers.
 */

import "./helpers/setupEnv.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "http";
import {
  parseBody,
  parseQuery,
  readRawBody,
  sendJson,
  sendStatus,
  sendXml,
  requireMethod,
} from "../src/core/httpAdapter.js";

// ── Mock helpers ────────────────────────────────────────────────────────────

/**
 * Build a fake IncomingMessage from a body string + headers.
 * We wrap a Readable in an object that also carries the url / method
 * / headers properties the adapter reads.
 */
function mockRequest(opts: {
  url?: string;
  method?: string;
  body?: string;
  contentType?: string;
}): IncomingMessage {
  // Readable.from(string) emits the string as a single string chunk,
  // but the httpAdapter reads chunks as Buffers. Hand-roll a Readable
  // so we can guarantee the emitted chunks are UTF-8 Buffers.
  const stream = new Readable({
    read() {
      this.push(opts.body ? Buffer.from(opts.body, "utf8") : null);
      this.push(null);
    },
  }) as unknown as IncomingMessage;

  (stream as unknown as {
    url?: string;
    method?: string;
    headers: Record<string, string>;
  }).url = opts.url;
  (stream as unknown as { method?: string }).method = opts.method;
  (stream as unknown as { headers: Record<string, string> }).headers = {
    ...(opts.contentType ? { "content-type": opts.contentType } : {}),
  };
  return stream;
}

/**
 * Minimal stub of ServerResponse that captures everything the
 * adapter sends: status code, headers, and body.
 */
function mockResponse(): {
  res: ServerResponse;
  getStatus: () => number | undefined;
  getHeader: (name: string) => string | undefined;
  getBody: () => string;
} {
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("readRawBody", () => {
  it("reads a streamed body to a UTF-8 string", async () => {
    const req = mockRequest({ body: "hello world" });
    assert.equal(await readRawBody(req), "hello world");
  });

  it("returns the empty string for no body", async () => {
    const req = mockRequest({});
    assert.equal(await readRawBody(req), "");
  });

  it("preserves UTF-8 multi-byte characters", async () => {
    const req = mockRequest({ body: "héllo 🚀" });
    assert.equal(await readRawBody(req), "héllo 🚀");
  });
});

describe("parseBody", () => {
  it("parses JSON body into a plain object", async () => {
    const req = mockRequest({
      body: '{"to":"+15551234567","role":"attorney"}',
      contentType: "application/json",
    });
    assert.deepEqual(await parseBody(req), {
      to: "+15551234567",
      role: "attorney",
    });
  });

  it("parses application/x-www-form-urlencoded (Twilio shape)", async () => {
    const req = mockRequest({
      body: "CallSid=CA123&From=%2B15551234567&CallStatus=ringing",
      contentType: "application/x-www-form-urlencoded",
    });
    assert.deepEqual(await parseBody(req), {
      CallSid: "CA123",
      From: "+15551234567",
      CallStatus: "ringing",
    });
  });

  it("returns empty object on missing body", async () => {
    const req = mockRequest({ contentType: "application/json" });
    assert.deepEqual(await parseBody(req), {});
  });

  it("returns empty object on malformed JSON (no throw)", async () => {
    const req = mockRequest({
      body: "{oops this isn't json",
      contentType: "application/json",
    });
    assert.deepEqual(await parseBody(req), {});
  });

  it("returns empty object for unknown content-type", async () => {
    const req = mockRequest({
      body: "something",
      contentType: "text/plain",
    });
    assert.deepEqual(await parseBody(req), {});
  });

  it("tolerates charset suffix in content-type", async () => {
    const req = mockRequest({
      body: '{"a":1}',
      contentType: "application/json; charset=utf-8",
    });
    assert.deepEqual(await parseBody(req), { a: 1 });
  });
});

describe("parseQuery", () => {
  it("parses a simple query string", () => {
    const req = mockRequest({ url: "/records?limit=10&cursor=abc" });
    assert.deepEqual(parseQuery(req), { limit: "10", cursor: "abc" });
  });

  it("returns empty object when there's no query string", () => {
    const req = mockRequest({ url: "/records" });
    assert.deepEqual(parseQuery(req), {});
  });

  it("returns empty object when req.url is undefined", () => {
    const req = mockRequest({});
    assert.deepEqual(parseQuery(req), {});
  });

  it("url-decodes percent-encoded values", () => {
    const req = mockRequest({ url: "/x?q=hello%20world%20%F0%9F%9A%80" });
    assert.deepEqual(parseQuery(req), { q: "hello world 🚀" });
  });
});

describe("sendJson / sendXml / sendStatus", () => {
  it("sendJson sets status, content-type, and body", () => {
    const { res, getStatus, getHeader, getBody } = mockResponse();
    sendJson(res, 200, { ok: true });
    assert.equal(getStatus(), 200);
    assert.equal(getHeader("content-type"), "application/json; charset=utf-8");
    assert.equal(getBody(), '{"ok":true}');
  });

  it("sendXml sets XML content-type", () => {
    const { res, getStatus, getHeader, getBody } = mockResponse();
    sendXml(res, 200, "<Response/>");
    assert.equal(getStatus(), 200);
    assert.equal(getHeader("content-type"), "text/xml; charset=utf-8");
    assert.equal(getBody(), "<Response/>");
  });

  it("sendStatus writes an empty response with the given code", () => {
    const { res, getStatus, getBody } = mockResponse();
    sendStatus(res, 204);
    assert.equal(getStatus(), 204);
    assert.equal(getBody(), "");
  });

  it("sendStatus can carry a text body (e.g. 'Forbidden')", () => {
    const { res, getStatus, getBody } = mockResponse();
    sendStatus(res, 403, "Forbidden");
    assert.equal(getStatus(), 403);
    assert.equal(getBody(), "Forbidden");
  });
});

describe("requireMethod", () => {
  it("returns true when the method matches", () => {
    const { res } = mockResponse();
    const req = mockRequest({ method: "POST" });
    assert.equal(requireMethod(req, res, "POST"), true);
  });

  it("returns false and writes 405 when the method doesn't match", () => {
    const { res, getStatus, getHeader } = mockResponse();
    const req = mockRequest({ method: "GET" });
    assert.equal(requireMethod(req, res, "POST"), false);
    assert.equal(getStatus(), 405);
    assert.equal(getHeader("allow"), "POST");
  });
});
