/**
 * tests/fakes/mcp.ts — Canned-response fake for callMCPTool.
 *
 * Tests that exercise the Claude → MCP tool call path use this to
 * avoid hitting a real CoTrackPro MCP server. The fake is
 * script-driven like FakeAnthropic: queue a response, the next
 * callMcpTool invocation returns it.
 *
 * Drop-in for the real `callMCPTool` via:
 *
 *   const fake = new FakeMcp();
 *   fake.queueResponse("Visitation schedule details: ...");
 *   handleCallStream(socket, { callMcpTool: fake.call, ... });
 */

export class FakeMcp {
  private queue: Array<string | Error> = [];
  /** Every invocation captured here for inspection. */
  public readonly calls: Array<{
    toolName: string;
    toolInput: Record<string, unknown>;
  }> = [];

  /** Queue a successful tool result. */
  queueResponse(result: string): void {
    this.queue.push(result);
  }

  /** Queue an error that the fake will throw on next invocation. */
  queueError(err: Error): void {
    this.queue.push(err);
  }

  /**
   * Drop-in for `callMCPTool`. Bound to `this` via arrow-function
   * so it can be passed directly as `deps.callMcpTool = fake.call`.
   */
  call = async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<string> => {
    this.calls.push({ toolName, toolInput });
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(
        "FakeMcp: response queue is empty — test did not queue enough responses",
      );
    }
    if (next instanceof Error) throw next;
    return next;
  };
}
