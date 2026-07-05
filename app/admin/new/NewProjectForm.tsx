"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, CircleCheck } from "lucide-react";
import { McpSnippet } from "@/components/McpSnippet";
import { createProject, type CreateProjectResult } from "./actions";

const PRESETS = ["#0f766e", "#4f46e5", "#c2410c", "#1d4ed8", "#be185d", "#111827"];

/**
 * Two-state flow: creation form, then the one-time token reveal. The token
 * never renders again after this screen — only its hash is stored.
 */
export function NewProjectForm() {
  const [color, setColor] = useState(PRESETS[0]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CreateProjectResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(formData: FormData) {
    setPending(true);
    setError(null);
    const res = await createProject(formData);
    setPending(false);
    if (res.error) setError(res.error);
    else setResult(res);
  }

  if (result?.token) {
    return (
      <div className="card p-5">
        <div className="mb-4 flex items-center gap-2">
          <CircleCheck className="h-5 w-5" style={{ color }} />
          <p className="font-medium">Project created</p>
        </div>

        <p className="mb-1.5 text-sm text-[--color-ink-mute]">MCP token</p>
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-[--color-line] bg-[--color-paper] px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-sm">{result.token}</code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(result.token!);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[--color-line] px-2 py-1 text-xs hover:bg-[--color-paper]"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Shown once — store it now.
        </p>

        <div className="mb-5">
          <McpSnippet token={result.token} />
        </div>

        <Link
          href={`/admin/${result.projectId}`}
          className="btn btn-ink"
        >
          Open project
        </Link>
      </div>
    );
  }

  return (
    <form action={onSubmit} className="card p-5">
      <label className="mb-1.5 block text-sm font-medium" htmlFor="name">
        Name
      </label>
      <input
        id="name"
        name="name"
        placeholder="Acme Landscaping"
        className="mb-4 w-full rounded-lg border border-[--color-line] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-200"
      />

      <p className="mb-1.5 text-sm font-medium">Brand color</p>
      <input type="hidden" name="color" value={color} />
      <div className="mb-5 flex items-center gap-2.5">
        {PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            aria-label={`Use ${c}`}
            className="h-6 w-6 rounded-full"
            style={{
              background: c,
              boxShadow: color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : undefined,
            }}
          />
        ))}
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-7 w-9 cursor-pointer rounded border border-[--color-line]"
          aria-label="Custom color"
        />
      </div>

      {error && (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="btn btn-ink w-full justify-center disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
