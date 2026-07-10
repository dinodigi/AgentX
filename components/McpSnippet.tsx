"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * The connect-from-Claude-Code handoff: full MCP endpoint URL plus a
 * paste-ready .mcp.json. Rendered wherever a token is revealed, because a
 * token without its URL is not enough to connect.
 */
export function McpSnippet({ token }: { token: string }) {
  const [copied, setCopied] = useState<"url" | "json" | null>(null);
  // Only rendered after user interaction, so window is always available.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = `${origin}/api/mcp`;

  const snippet = JSON.stringify(
    {
      mcpServers: {
        agentx: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );

  async function copy(kind: "url" | "json", text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div>
      <p className="mb-1.5 text-sm text-ink-mute">MCP endpoint</p>
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-sm">{url}</code>
        <button
          type="button"
          onClick={() => copy("url", url)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:bg-paper"
        >
          {copied === "url" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied === "url" ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="mb-1.5 flex items-center">
        <p className="text-sm text-ink-mute">
          Save as <code className="font-mono text-xs">.mcp.json</code> in the site&apos;s repo,
          then restart Claude Code
        </p>
        <button
          type="button"
          onClick={() => copy("json", snippet)}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:bg-paper"
        >
          {copied === "json" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied === "json" ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-paper p-3 font-mono text-xs leading-relaxed text-ink-soft">
        {snippet}
      </pre>
    </div>
  );
}
