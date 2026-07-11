"use client";

import { useState } from "react";
import { deleteProjectAction } from "./actions";

/**
 * The danger zone (B2). A GitHub-style type-the-name confirm before a
 * permanent, cascading project delete. Only rendered for users who can actually
 * delete (workspace owner/admin) — the server re-checks regardless.
 */
export function DeleteProjectSection({
  projectId,
  label,
  counts,
}: {
  projectId: string;
  label: string;
  counts: { collections: number; entries: number; assets: number };
}) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === label;

  return (
    <div
      className="card max-w-lg p-5"
      style={{ borderColor: "color-mix(in srgb, var(--color-err) 45%, var(--color-line))" }}
    >
      <p className="mb-3 text-sm leading-relaxed text-ink-mute">
        Permanently deletes <span className="font-semibold text-ink">{label}</span> and everything in it —{" "}
        {counts.collections} {counts.collections === 1 ? "collection" : "collections"}, {counts.entries}{" "}
        {counts.entries === 1 ? "entry" : "entries"}, {counts.assets} media{" "}
        {counts.assets === 1 ? "file" : "files"}, plus its tokens, members and connectors. This can&apos;t be
        undone.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!matches || pending) return;
          setPending(true);
          setError(null);
          const fd = new FormData();
          fd.set("confirm", typed);
          // On success the action redirects server-side; only errors return here.
          const res = await deleteProjectAction(projectId, fd);
          setPending(false);
          if (res?.error) setError(res.error);
        }}
        className="flex flex-col gap-2"
      >
        <label className="text-xs text-ink-mute">
          Type <span className="font-mono text-ink">{label}</span> to confirm
        </label>
        <div className="flex gap-2">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={label}
            autoComplete="off"
            className="field-input flex-1"
          />
          <button
            type="submit"
            disabled={!matches || pending}
            className="btn shrink-0 border-err text-err transition-colors hover:bg-err hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Deleting…" : "Delete project"}
          </button>
        </div>
      </form>
      {error && <p className="mt-2 text-sm text-err">{error}</p>}
    </div>
  );
}
