/**
 * tests/fakes/twilioSocket.ts — Test double for the Twilio Media Stream
 * WebSocket that `handleCallStream` accepts.
 *
 * The real `ws.WebSocket` has a huge surface area; `handleCallStream`
 * only uses six operations:
 *
 *   - `twilioWs.readyState` (compared to 1, which is WebSocket.OPEN)
 *   - `twilioWs.send(payload)`
 *   - `twilioWs.close(code?, reason?)`
 *   - `twilioWs.on("message", handler)`
 *   - `twilioWs.on("close", handler)`
 *   - `twilioWs.on("error", handler)`
 *
 * This fake implements exactly that surface, plus test-only helpers to
 * drive the socket from outside: `emitMessage`, `emitClose`, and the
 * captured `sentMessages` list. Tests import this, instantiate one,
 * and pass it to `handleCallStream(fake as unknown as WebSocket)`.
 *
 * The cast is deliberate — structurally matching the real `ws.WebSocket`
 * would require implementing ~40 methods we don't touch. Using `as
 * unknown as WebSocket` narrows the trust boundary to this one line in
 * each test and keeps the fake small.
 */

import { EventEmitter } from "node:events";

/** Twilio's inbound WS message shape, as used by tests. */
export type TwilioFakeInbound =
  | { event: "connected"; protocol: string; version: string }
  | {
      event: "start";
      sequenceNumber: string;
      start: {
        streamSid: string;
        accountSid: string;
        callSid: string;
        tracks: string[];
        customParameters: Record<string, string>;
        mediaFormat: { encoding: string; sampleRate: number; channels: number };
      };
      streamSid: string;
    }
  | {
      event: "media";
      sequenceNumber: string;
      media: { track: string; chunk: string; timestamp: string; payload: string };
      streamSid: string;
    }
  | {
      event: "mark";
      sequenceNumber: string;
      streamSid: string;
      mark: { name: string };
    }
  | {
      event: "stop";
      sequenceNumber: string;
      streamSid: string;
      stop: { accountSid: string; callSid: string };
    };

export class FakeTwilioSocket extends EventEmitter {
  /** Node `ws.WebSocket` exposes `readyState`; 1 means OPEN. */
  public readyState = 1;

  /** Every `send()` call is captured here, parsed if it's JSON. */
  public readonly sentMessages: Array<Record<string, unknown>> = [];

  /** Every raw send payload, for tests that want to inspect the wire format. */
  public readonly rawSent: string[] = [];

  /** Set by `close()` so tests can assert on the close code / reason. */
  public closedCode: number | undefined;
  public closedReason: string | undefined;

  /**
   * Called by the handler to emit outbound media / mark / clear frames.
   * We parse each payload into `sentMessages` for easy assertions; the
   * raw string is also captured in `rawSent` for tests that want to
   * verify the exact wire format (e.g. the pre-built media prefix
   * optimization in callHandler).
   */
  send(payload: string): void {
    this.rawSent.push(payload);
    try {
      this.sentMessages.push(JSON.parse(payload));
    } catch {
      // Not JSON — store a placeholder so the index lines up with rawSent.
      this.sentMessages.push({ _raw: payload });
    }
  }

  /**
   * Handler-side close. Tests usually use `emitClose` to SIMULATE
   * Twilio closing the socket; this method is what the handler calls
   * when IT decides to close the socket (e.g. capacity rejection).
   */
  close(code?: number, reason?: string): void {
    this.closedCode = code;
    this.closedReason = reason;
    this.readyState = 3; // CLOSED
    // Mirror ws behavior: a close initiated from our side fires the
    // close event once the other side acks. For tests we fire
    // synchronously — there's no "other side."
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }

  // ── Test-only drive helpers ────────────────────────────────────

  /** Simulate Twilio sending a message to us. */
  emitMessage(msg: TwilioFakeInbound): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }

  /** Simulate Twilio closing the socket on its end. */
  emitClose(code: number = 1000, reason: string = ""): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  /** Simulate a transport error. */
  emitError(err: Error): void {
    this.emit("error", err);
  }

  // ── Assertion helpers ──────────────────────────────────────────

  /** Return all `media` events sent to Twilio (outbound audio). */
  mediaSent(): Array<{ payload: string }> {
    return this.sentMessages
      .filter(
        (m): m is { event: "media"; media: { payload: string } } =>
          (m as { event?: unknown }).event === "media",
      )
      .map((m) => m.media);
  }

  /** Return all `mark` event names sent to Twilio. */
  marksSent(): string[] {
    return this.sentMessages
      .filter(
        (m): m is { event: "mark"; mark: { name: string } } =>
          (m as { event?: unknown }).event === "mark",
      )
      .map((m) => m.mark.name);
  }

  /** True if the handler ever sent a `clear` event to Twilio (barge-in). */
  sawClear(): boolean {
    return this.sentMessages.some(
      (m) => (m as { event?: unknown }).event === "clear",
    );
  }
}
