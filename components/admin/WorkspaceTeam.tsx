"use client";

import { useState } from "react";
import { Check, Pencil, Trash2 } from "lucide-react";
import { addWorkspaceMember, removeWorkspaceMember, renameWorkspace } from "@/app/admin/workspace/actions";
import type { WorkspaceMemberRow } from "@/lib/workspaces";

/**
 * Workspace team management (B1b). Owner/admin add and remove members (roles
 * admin | manager) who then reach every project the workspace owns; the owner
 * can rename the workspace. Managers see the roster read-only.
 */
export function WorkspaceTeam({
  workspaceId,
  name,
  members,
  canManage,
  isOwner,
}: {
  workspaceId: string;
  name: string;
  members: WorkspaceMemberRow[];
  canManage: boolean;
  isOwner: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);

  return (
    <div className="mx-auto max-w-[860px] px-5 py-8 md:px-10 md:py-10">
      <p className="eyebrow mb-1">Workspace</p>
      {editingName ? (
        <form
          action={async (fd) => {
            const res = await renameWorkspace(workspaceId, fd);
            setError(res.error ?? null);
            if (!res.error) setEditingName(false);
          }}
          className="mb-2 flex items-center gap-2"
        >
          <input name="name" defaultValue={name} autoFocus className="field-input max-w-xs" />
          <button type="submit" className="btn btn-primary" aria-label="Save name">
            <Check className="h-4 w-4" />
          </button>
          <button type="button" className="text-sm text-ink-mute hover:text-ink" onClick={() => setEditingName(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="mb-1 flex items-center gap-2">
          <h1 className="display text-[22px] font-semibold leading-none">{name}</h1>
          {isOwner && (
            <button
              type="button"
              aria-label="Rename workspace"
              onClick={() => setEditingName(true)}
              className="rounded p-1 text-ink-mute transition-colors hover:text-ink"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      <p className="mb-7 text-sm text-ink-mute">
        Members reach every project this workspace owns. To share a single project with an outsider, add them on that
        project&apos;s Settings instead.
      </p>

      <div className="card max-w-lg p-5">
        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-line-strong">
          Members · {members.length}
        </p>
        <ul className="mb-4 divide-y divide-line">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-2 py-2.5 text-sm">
              <span className="truncate">{m.email}</span>
              <span className="rounded-full bg-paper px-2 py-0.5 text-xs text-ink-soft">{m.role}</span>
              {canManage && m.role !== "owner" && (
                <button
                  type="button"
                  aria-label={`Remove ${m.email}`}
                  onClick={async () => {
                    const res = await removeWorkspaceMember(workspaceId, m.id);
                    setError(res.error ?? null);
                  }}
                  className="ml-auto rounded p-1 text-ink-mute transition-colors hover:text-err"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>

        {canManage ? (
          <form
            action={async (fd) => {
              const res = await addWorkspaceMember(workspaceId, fd);
              setError(res.error ?? null);
            }}
            className="flex gap-2"
          >
            <input name="email" placeholder="teammate@company.com" className="field-input flex-1" />
            <select name="role" defaultValue="manager" className="field-input w-28 shrink-0">
              <option value="manager">manager</option>
              <option value="admin">admin</option>
            </select>
            <button type="submit" className="btn btn-primary shrink-0">
              Add
            </button>
          </form>
        ) : (
          <p className="text-sm text-ink-mute">Only owners and admins can change the team.</p>
        )}
        {error && <p className="mt-2 text-sm text-err">{error}</p>}
      </div>
    </div>
  );
}
