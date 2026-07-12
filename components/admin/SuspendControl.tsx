"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { suspendProjectAction, unsuspendProjectAction } from "@/app/admin/console/actions";

/**
 * The console's abuse lever (B4). Suspend is plan + confirm (design rule):
 * the expander states exactly what goes dark and requires a reason — the
 * reason is shown to the tenant on their suspension banner, so it's part of
 * the action, not decoration. Unsuspend is one click (restoring service needs
 * no ceremony).
 */
export function SuspendControl({ projectId, name, status }: { projectId: string; name: string; status: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (status !== "active" && status !== "suspended") return null; // setup: already dark

  const run = (fn: () => Promise<{ error?: string; ok?: boolean }>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (r.error) {
        setError(r.error);
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
    });
  };

  if (status === "suspended") {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => unsuspendProjectAction(projectId))}
          className="btn btn-ink disabled:opacity-60"
        >
          {pending ? "Restoring…" : "Unsuspend"}
        </button>
        {error && <p className="m-0 max-w-[220px] text-right text-[11px] text-err">{error}</p>}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-danger-ghost rounded-lg px-2.5 py-1.5 font-mono text-[11px]"
      >
        Suspend
      </button>
    );
  }

  return (
    <div className="flex w-[260px] flex-col gap-2 rounded-lg border border-line bg-raised p-3">
      <p className="m-0 text-[12px] leading-snug text-ink-mute">
        Suspending <span className="font-medium text-ink">{name}</span> darkens its MCP + delivery APIs
        immediately. The admin stays reachable and shows the tenant this reason:
      </p>
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (tenant-visible)"
        className="w-full rounded-md border border-line bg-card px-2 py-1.5 text-[12px] text-ink outline-none focus:border-line-strong"
      />
      {error && <p className="m-0 text-[11px] text-err">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="btn btn-ink">
          Cancel
        </button>
        <button
          type="button"
          disabled={pending || !reason.trim()}
          onClick={() => run(() => suspendProjectAction(projectId, reason))}
          className="btn-danger-ghost rounded-lg px-3 py-1.5 font-mono text-[11px] disabled:opacity-50"
        >
          {pending ? "Suspending…" : "Suspend project"}
        </button>
      </div>
    </div>
  );
}
