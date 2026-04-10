/**
 * services/mcp.ts — CoTrackPro MCP server client
 *
 * Makes HTTP requests to the CoTrackPro MCP server when Claude
 * requests a tool call. Returns the tool result as a string
 * that gets fed back into the Anthropic conversation.
 *
 * TRANSPORT: Streamable HTTP (POST to MCP endpoint)
 * AUTH: Bearer token if required by your MCP server config.
 *
 * NOTE: This is a lightweight MCP client. For production, consider
 * using the official @modelcontextprotocol/sdk client.
 */

import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ service: "mcp" });

interface MCPCallToolRequest {
  jsonrpc: "2.0";
  id: string;
  method: "tools/call";
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface MCPCallToolResponse {
  jsonrpc: "2.0";
  id: string;
  result?: {
    content: Array<{
      type: string;
      text?: string;
    }>;
    isError?: boolean;
  };
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Call a CoTrackPro MCP tool and return the text result.
 *
 * @param toolName  — e.g. "start_session", "check_safety"
 * @param toolInput — the arguments Claude provided
 * @returns         — text content from the MCP tool result
 */
export async function callMCPTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string> {
  const requestId = `voice-${Date.now()}`;

  const body: MCPCallToolRequest = {
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: toolInput,
    },
  };

  log.info({ toolName, requestId }, "Calling MCP tool");

  try {
    const response = await fetch(env.cotrackproMcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Add bearer token if your MCP server requires auth:
        // "Authorization": `Bearer ${env.mcpAuthToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000), // 30s timeout
    });

    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as MCPCallToolResponse;

    if (data.error) {
      log.error({ error: data.error }, "MCP tool returned error");
      return `Error: ${data.error.message}`;
    }

    if (!data.result?.content) {
      return "No result returned from the tool.";
    }

    // Extract text blocks from the MCP result
    const text = data.result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

    log.info({ toolName, resultLength: text.length }, "MCP tool result received");
    return text || "Tool completed successfully.";
  } catch (err) {
    log.error({ err, toolName }, "MCP tool call failed");

    // Graceful fallback — let Claude know the tool failed
    if (err instanceof Error && err.name === "TimeoutError") {
      return "The CoTrackPro system is not responding right now. Please try again in a moment.";
    }
    return `Tool call failed: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}
