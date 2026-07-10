"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * A copyable endpoint — the concrete thing an operator wires their site or
 * points their agent at. Mono, because it's a machine value.
 */
export function EndpointField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[--color-ink-mute]">
        {label}
      </span>
      <div className="flex items-center gap-2 rounded-lg border border-[--color-line] bg-[--color-raised] px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[--color-ink]">{value}</code>
        <button
          type="button"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="shrink-0 rounded p-1 text-[--color-ink-mute] transition-colors hover:text-[--color-ink]"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" style={{ color: "var(--color-accent)" }} />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
