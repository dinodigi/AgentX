"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, CircleCheck } from "lucide-react";
import { McpSnippet } from "@/components/McpSnippet";
import { createProject, type CreateProjectResult } from "./actions";

const PRESETS = ["#0f766e", "#4f46e5", "#c2410c", "#1d4ed8", "#be185d", "#111827"];

const PLANS = [
  {
    id: "sandbox",
    label: "Sandbox",
    price: "Free",
    blurb: "One per workspace. Shared infrastructure, hard caps — the place to try things.",
  },
  {
    id: "byo",
    label: "Bring your own",
    price: "$19/mo",
    blurb: "Your Neon database (and optionally your bucket) — your keys, your data.",
  },
  {
    id: "managed",
    label: "Managed",
    price: "$29/mo",
    blurb: "We provision and run a dedicated database + bucket for this project.",
  },
] as const;

/**
 * Two-state flow: creation form, then the one-time token reveal. The token
 * never renders again after this screen — only its hash is stored.
 */
export function NewProjectForm({
  sandboxUsed,
  canCreatePaid,
}: {
  /** The active workspace already has its free sandbox. */
  sandboxUsed: boolean;
  /** Paid planes stay invite-only until B3 wires billing (operators bypass). */
  canCreatePaid: boolean;
}) {
  const [color, setColor] = useState(PRESETS[0]);
  const [plan, setPlan] = useState<string>(sandboxUsed ? "byo" : "sandbox");
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

        <p className="mb-1.5 text-sm text-ink-mute">MCP token</p>
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-sm">{result.token}</code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(result.token!);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:bg-paper"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <p className="alert-warn mb-4 rounded-lg px-3 py-2 text-sm">
          Shown once — store it now.
        </p>

        <div className="mb-5">
          <McpSnippet token={result.token} />
        </div>

        {result.status === "setup" && (
          <p className="mb-4 text-sm text-ink-mute">
            Next: pick this project&apos;s data plane (connect your database or
            provision a managed one). The agent surfaces light up once it&apos;s
            active.
          </p>
        )}
        <Link
          href={`/admin/${result.projectId}`}
          className="btn btn-ink"
        >
          {result.status === "setup" ? "Set up the data plane →" : "Open project"}
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
        className="field-input mb-4"
      />

      <p className="mb-1.5 text-sm font-medium">Plan</p>
      <input type="hidden" name="plan" value={plan} />
      <div className="mb-4 space-y-2">
        {PLANS.map((p) => {
          const sandboxTaken = p.id === "sandbox" && sandboxUsed;
          const paidLocked = p.id !== "sandbox" && !canCreatePaid;
          const disabled = sandboxTaken || paidLocked;
          return (
            <button
              key={p.id}
              type="button"
              disabled={disabled}
              onClick={() => setPlan(p.id)}
              className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                plan === p.id ? "border-ink bg-paper" : "border-line hover:border-line-strong"
              } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <span className="flex items-baseline justify-between">
                <span className="text-sm font-medium">{p.label}</span>
                <span className="text-xs text-ink-mute">{p.price}</span>
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-mute">
                {sandboxTaken
                  ? "This workspace already has its free sandbox."
                  : paidLocked
                    ? "Invite-only during the beta — your free sandbox is available now."
                    : p.blurb}
              </span>
            </button>
          );
        })}
      </div>

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
          className="h-7 w-9 cursor-pointer rounded border border-line"
          aria-label="Custom color"
        />
      </div>

      {error && (
        <p className="alert-error mb-3 rounded-lg px-3 py-2 text-sm">{error}</p>
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
