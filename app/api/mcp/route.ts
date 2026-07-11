import { NextRequest } from "next/server";
import { bearerFrom, resolveToken } from "@/lib/tokens";
import { TOOL_DEFS, callTool } from "@/lib/mcp/tools";
import { ERROR_CODES } from "@/lib/error-codes";
import { originFromHeaders } from "@/lib/origin";

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

/**
 * The PUBLIC origin to stamp into the URLs the tools report (get_project_info,
 * the generated client's base URL). `new URL(req.url).origin` is the address
 * the process was reached on — behind a proxy (Render, Netlify) that is the
 * internal bind (http://localhost:10000), not the public host. Prefer an
 * explicit APP_URL, then the proxy's forwarded host, and only fall back to the
 * raw request origin for local dev.
 */
function publicOrigin(req: NextRequest): string {
  const reqOrigin = new URL(req.url).origin;
  return (
    originFromHeaders((n) => req.headers.get(n), new URL(req.url).protocol.replace(":", "")) ?? reqOrigin
  );
}

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
  const info = await resolveToken(token);
  if (!info) {
    return new Response("Unauthorized: invalid project token", { status: 401 });
  }
  if (info.scope !== "mcp") {
    return new Response(
      "Unauthorized [E_SCOPE]: this token is delivery-scoped (public read/write only). MCP needs an mcp-scoped token.",
      { status: 401 },
    );
  }
  if (info.projectStatus !== "active") {
    return new Response(
      "Forbidden [E_PROJECT_SETUP]: this project hasn't finished setup — pick its data plane (connect or provision a database) in the admin and activate it, then retry.",
      { status: 403 },
    );
  }
  const projectId = info.projectId;

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
      const toolResult = await callTool(projectId, name, args, {
        baseUrl: publicOrigin(req),
      });
      return result(msg.id, toolResult);
    }

    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

/** A bare GET is handy for a liveness check / confirming the token works. */
export async function GET(req: NextRequest) {
  const token = bearerFrom(req.headers.get("authorization"));
  const info = token ? await resolveToken(token) : null;
  return Response.json({
    server: "agentx-mcp",
    protocolVersion: PROTOCOL_VERSION,
    authenticated: info?.scope === "mcp",
    scope: info?.scope ?? null,
    env: info?.env ?? null,
    tools: TOOL_DEFS.map((t) => t.name),
    errorCodes: ERROR_CODES,
    errorFormat:
      "tool errors: line 1 is `Error [CODE]: message`; validation-shaped failures append " +
      "`issues: [{field, constraint, limit?, allowed?, pattern?, hint}]` — parse it to repair inputs " +
      "field by field (constraint kinds: type|required|required_if|min|max|pattern|enum|unique|unknown_field|ref_missing)",
  });
}
