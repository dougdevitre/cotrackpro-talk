/**
 * tests/fakes/anthropic.ts — Scripted Anthropic Claude fake.
 *
 * The real `src/services/anthropic.ts` exports `streamResponse` and
 * `sendToolResult`, each of which opens a streaming connection to
 * Claude, emits text deltas via callbacks, and resolves when the
 * response completes (or fires onToolUse if Claude wants to invoke
 * a tool).
 *
 * This module provides scripted drop-in replacements. Tests queue
 * up "what Claude says next" and the fakes play it back through the
 * callbacks, exactly mirroring the real contract.
 *
 * Usage:
 *
 *   const fake = new FakeAnthropic();
 *   fake.queueResponse({ type: "text", text: "Hello there." });
 *   fake.queueResponse({
 *     type: "toolUse",
 *     toolName: "searchDocs",
 *     toolInput: { q: "visitation" },
 *     toolUseId: "toolu_test_1",
 *   });
 *   fake.queueResponse({ type: "text", text: "Here's what I found." });
 *
 *   handleCallStream(socket, {
 *     streamResponse: fake.streamResponse,
 *     sendToolResult: fake.sendToolResult,
 *     ...
 *   });
 */

import type { StreamCallbacks } from "../../src/services/anthropic.js";
import type { CallSession } from "../../src/types/index.js";

/**
 * A single "next thing Claude says" script entry. The fake consumes
 * one entry per `streamResponse` / `sendToolResult` invocation.
 */
export type FakeResponse =
  | {
      /** Plain text response. Delivered as a single delta + onComplete. */
      type: "text";
      text: string;
      /**
       * Optional: split the text into N deltas instead of one, so tests
       * can exercise the sentence-piping path in makeSentencePipedCallbacks.
       */
      deltas?: string[];
    }
  | {
      /** Claude requests a tool call. Fires onToolUse instead of onComplete. */
      type: "toolUse";
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId: string;
    }
  | {
      /** Simulate Claude throwing. Fires onError. */
      type: "error";
      error: Error;
    };

export class FakeAnthropic {
  private queue: FakeResponse[] = [];
  /** Every call to streamResponse + sendToolResult captured here for inspection. */
  public readonly calls: Array<{
    kind: "streamResponse" | "sendToolResult";
    sessionCallSid: string;
    toolUseId?: string;
  }> = [];

  /** Add a scripted response to the tail of the queue. */
  queueResponse(r: FakeResponse): void {
    this.queue.push(r);
  }

  /** Snapshot of how many responses are still queued. */
  pending(): number {
    return this.queue.length;
  }

  /**
   * Shift and return the next scripted response, or throw if the
   * queue is empty. Tests should always queue enough responses for
   * every Claude invocation the handler will make.
   */
  private next(): FakeResponse {
    const r = this.queue.shift();
    if (!r) {
      throw new Error(
        "FakeAnthropic: response queue is empty — test did not queue enough responses",
      );
    }
    return r;
  }

  /**
   * Drop-in for the real `streamResponse`. Bound to `this` via the
   * arrow-function form so it can be passed directly as
   * `deps.streamResponse = fake.streamResponse`.
   */
  streamResponse = async (
    session: CallSession,
    callbacks: StreamCallbacks,
  ): Promise<void> => {
    this.calls.push({
      kind: "streamResponse",
      sessionCallSid: session.callSid,
    });
    await this.play(this.next(), callbacks);
  };

  /** Drop-in for the real `sendToolResult`. */
  sendToolResult = async (
    session: CallSession,
    toolUseId: string,
    _toolResult: string,
    callbacks: StreamCallbacks,
  ): Promise<void> => {
    this.calls.push({
      kind: "sendToolResult",
      sessionCallSid: session.callSid,
      toolUseId,
    });
    await this.play(this.next(), callbacks);
  };

  /** Turn a scripted response into a sequence of callback invocations. */
  private async play(
    r: FakeResponse,
    callbacks: StreamCallbacks,
  ): Promise<void> {
    if (r.type === "error") {
      callbacks.onError(r.error);
      return;
    }

    if (r.type === "toolUse") {
      if (!callbacks.onToolUse) {
        throw new Error(
          "FakeAnthropic: script has toolUse but callbacks.onToolUse is undefined",
        );
      }
      await callbacks.onToolUse(r.toolName, r.toolInput, r.toolUseId);
      return;
    }

    // r.type === "text"
    const deltas = r.deltas ?? [r.text];
    for (const delta of deltas) {
      await callbacks.onTextDelta(delta);
    }
    await callbacks.onComplete(r.text);
  }
}
