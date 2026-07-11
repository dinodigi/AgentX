"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleCheck, Circle, Database, HardDrive } from "lucide-react";
import { activateProject, provisionManagedAction } from "@/app/admin/[projectId]/settings/actions";

/**
 * The setup surface (B2): what a paid project shows instead of its overview
 * until a data plane exists and the operator activates it. The MCP token and
 * delivery API stay dark until then — agents come in on an active project.
 */
export function SetupPanel(p: {
  projectId: string;
  name: string;
  plan: "byo" | "managed" | null;
  dbConnected: boolean;
  dbStatus: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto max-w-xl">
      <p className="eyebrow mb-1">Setup</p>
      <h1 className="display mb-1 text-xl font-semibold">{p.name} isn&apos;t live yet</h1>
      <p className="mb-6 max-w-md text-sm text-ink-mute">
        Pick where this project&apos;s content lives, then activate. The MCP
        token and delivery API stay dark until it&apos;s active — set up the
        plane <em>before</em> the agent starts building.
      </p>

      <div className="card mb-4 p-5">
        <div className="mb-2 flex items-center gap-2">
          {p.dbConnected ? (
            <CircleCheck className="h-4 w-4" style={{ color: "var(--color-ok)" }} />
          ) : (
            <Circle className="h-4 w-4 text-ink-mute" />
          )}
          <Database className="h-4 w-4 text-ink-mute" />
          <p className="text-sm font-medium">1 · Database (required)</p>
          {p.dbStatus && !p.dbConnected && <span className="text-xs text-ink-mute">{p.dbStatus}</span>}
        </div>
        {p.dbConnected ? (
          <p className="text-sm text-ink-mute">Connected — this project has its own database.</p>
        ) : p.plan === "managed" ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn btn-primary disabled:opacity-60"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                setNote(null);
                const res = await provisionManagedAction(p.projectId);
                setBusy(false);
                setError(res.error ?? null);
                if (!res.error) {
                  setNote(res.detail ?? "Provisioned");
                  router.refresh();
                }
              }}
            >
              {busy ? "Provisioning…" : "Provision managed database"}
            </button>
            <span className="text-xs text-ink-mute">~30 seconds, one click</span>
          </div>
        ) : (
          <p className="text-sm text-ink-mute">
            Paste your Neon connection string on the{" "}
            <Link href={`/admin/${p.projectId}/connectors`} className="underline hover:text-ink">
              Connectors tab
            </Link>{" "}
            — it&apos;s validated and the schema installed before anything is stored.
          </p>
        )}
      </div>

      <div className="card mb-4 p-5">
        <div className="mb-2 flex items-center gap-2">
          <Circle className="h-4 w-4 text-ink-mute" />
          <HardDrive className="h-4 w-4 text-ink-mute" />
          <p className="text-sm font-medium">2 · Storage (optional)</p>
        </div>
        <p className="text-sm text-ink-mute">
          Media uses the shared plane unless you attach a bucket on the{" "}
          <Link href={`/admin/${p.projectId}/connectors`} className="underline hover:text-ink">
            Connectors tab
          </Link>
          . You can do this any time before uploading.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn btn-ink disabled:opacity-60"
          disabled={busy || !p.dbConnected}
          title={p.dbConnected ? undefined : "Connect or provision the database first"}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const res = await activateProject(p.projectId);
            setBusy(false);
            setError(res.error ?? null);
            if (res.ok) router.refresh();
          }}
        >
          {busy ? "Working…" : "Activate project"}
        </button>
        {note && <span className="text-xs text-ink-mute">{note}</span>}
      </div>
      {error && <p className="alert-error mt-3 rounded-lg px-3 py-2 text-sm">{error}</p>}
    </div>
  );
}
