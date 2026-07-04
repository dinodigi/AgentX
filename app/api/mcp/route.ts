import { NextRequest } from "next/server";
import { bearerFrom, resolveProjectId } from "@/lib/tokens";
import { TOOL_DEFS, callTool } from "@/lib/mcp/tools";

/**
 * MCP endpoint (Streamable HTTP, JSON responses). ONE server for all projects —
 * the bearer token scopes each request to a single project. Claude Code / Cursor
 * connect here with the project token.
 *
 * We implement the JSON-RPC subset MCP needs for a stateless tool server:
 * initialize, notifications/initialized, tools/list, tools/call. Non-streaming
 * request/response tools return a single application/json body, which the
 * Streamable HTTP transport accepts.
 */

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result: value });
}
function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

export async function POST(req: NextRequest) {
  const token = bearerFrom(req.headers.get("authorization"));
  if (!token) {
    return new Response("Unauthorized: missing bearer token", { status: 401 });
  }
  const projectId = await resolveProjectId(token);
  if (!projectId) {
    return new Response("Unauthorized: invalid project token", { status: 401 });
  }

  let msg: JsonRpcRequest;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "parse error");
  }

  switch (msg.method) {
    case "initialize":
      return result(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "agentx", version: "0.1.0" },
      });

    // Notifications carry no id and expect no body.
    case "notifications/initialized":
    case "notifications/cancelled":
      return new Response(null, { status: 202 });

    case "ping":
      return result(msg.id, {});

    case "tools/list":
      return result(msg.id, { tools: TOOL_DEFS });

    case "tools/call": {
      const name = msg.params?.name as string;
      const args = msg.params?.arguments ?? {};
      if (!name) return rpcError(msg.id, -32602, "missing tool name");
      const toolResult = await callTool(projectId, name, args);
      return result(msg.id, toolResult);
    }

    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

/** A bare GET is handy for a liveness check / confirming the token works. */
export async function GET(req: NextRequest) {
  const token = bearerFrom(req.headers.get("authorization"));
  const projectId = token ? await resolveProjectId(token) : null;
  return Response.json({
    server: "agentx-mcp",
    protocolVersion: PROTOCOL_VERSION,
    authenticated: Boolean(projectId),
    tools: TOOL_DEFS.map((t) => t.name),
  });
}
