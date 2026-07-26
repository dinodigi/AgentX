"use client";

import { useState } from "react";
import { approveAuthorization } from "./actions";

/**
 * The consent UI. Two jobs, and the ORDER matters: pick the project first, then
 * the permissions. A person can only judge "may it change the content model?"
 * once they know *whose* content model.
 */
export function ConsentForm({
  clientName,
  clientUri,
  groups,
  scopes,
  hidden,
}: {
  clientName: string;
  clientUri: string | null;
  groups: { workspace: string; projects: { id: string; name: string; status: string }[] }[];
  scopes: { id: string; label: string; preselected: boolean }[];
  hidden: Record<string, string>;
}) {
  const first = groups[0]?.projects[0]?.id ?? "";
  const [projectId, setProjectId] = useState(first);
  const [granted, setGranted] = useState<string[]>(scopes.filter((s) => s.preselected).map((s) => s.id));
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setGranted((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  const selectedName = groups.flatMap((g) => g.projects).find((p) => p.id === projectId)?.name ?? "";

  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <div className="card p-6">
        <p className="eyebrow mb-1">Connect an application</p>
        <h1 className="display mb-1 text-xl font-semibold">
          {clientName} wants access to a project
        </h1>
        {clientUri && <p className="mb-4 break-all text-xs text-ink-mute">{clientUri}</p>}

        <form
          action={async (fd) => {
            setBusy(true);
            fd.set("project_id", projectId);
            fd.set("scopes", granted.join(" "));
            for (const [k, v] of Object.entries(hidden)) fd.set(k, v);
            await approveAuthorization(fd);
            setBusy(false);
          }}
        >
          <fieldset className="mb-6">
            <legend className="mb-2 text-sm font-medium">1 · Which project?</legend>
            <div className="flex flex-col gap-2">
              {groups.map((g) => (
                <div key={g.workspace}>
                  {groups.length > 1 && (
                    <p className="mb-1 text-[11px] uppercase tracking-wide text-ink-mute">{g.workspace}</p>
                  )}
                  {g.projects.map((p) => (
                    <label
                      key={p.id}
                      className="mb-1 flex cursor-pointer items-center gap-3 rounded-lg border border-line p-3 text-sm hover:border-line-strong"
                    >
                      <input
                        type="radio"
                        name="project_pick"
                        value={p.id}
                        checked={projectId === p.id}
                        onChange={() => setProjectId(p.id)}
                      />
                      <span className="flex-1">{p.name}</span>
                      {p.status !== "active" && (
                        <span className="text-[11px] text-ink-mute">{p.status}</span>
                      )}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset className="mb-6">
            <legend className="mb-2 text-sm font-medium">2 · What may it do?</legend>
            <div className="flex flex-col gap-1">
              {scopes.map((s) => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-start gap-3 rounded-lg p-2 text-sm hover:bg-paper"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={granted.includes(s.id)}
                    onChange={() => toggle(s.id)}
                  />
                  <span>
                    <span className="block">{s.label}</span>
                    <code className="text-[11px] text-ink-mute">{s.id}</code>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-mute">
              Uncheck anything this application should not need. You can revoke the whole
              connection later in the project&apos;s Settings → Tokens.
            </p>
          </fieldset>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              className="btn btn-ink disabled:opacity-60"
              disabled={busy || !projectId || granted.length === 0}
            >
              {busy ? "Authorizing…" : `Authorize for ${selectedName || "…"}`}
            </button>
            <button
              type="submit"
              name="deny"
              value="1"
              className="btn"
              disabled={busy}
              formNoValidate
            >
              Cancel
            </button>
          </div>
          {granted.length === 0 && (
            <p className="mt-2 text-xs text-ink-mute">Select at least one permission, or cancel.</p>
          )}
        </form>
      </div>
    </main>
  );
}
