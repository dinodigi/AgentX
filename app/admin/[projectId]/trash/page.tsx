import { listTrash } from "@/lib/trash";
import { ConfirmButton } from "@/components/ConfirmButton";
import { restoreEntryAction, purgeEntryAction } from "../../actions";

/** A compact one-line preview of a trashed row: its first stringy field value. */
function preview(data: Record<string, unknown>): string {
  for (const v of Object.values(data)) {
    if (typeof v === "string" && v.trim()) return v.length > 60 ? v.slice(0, 60) + "…" : v;
  }
  return "(no preview)";
}

function actorLabel(actor: { type: string }): string {
  switch (actor.type) {
    case "mcp":
      return "the agent";
    case "admin":
      return "an admin";
    case "delivery":
      return "the site";
    default:
      return "unknown";
  }
}

/**
 * Trash: soft-deleted entries across the project, newest-deleted first. Restore
 * brings a row back; Purge removes it permanently. Everything auto-purges after
 * ~30 days.
 */
export default async function TrashPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { rows } = await listTrash(projectId, { limit: 100 });

  return (
    <>
      <div className="mb-5 flex items-center gap-3">
        <h1 className="display text-xl font-semibold">Trash</h1>
        <span className="text-sm text-ink-mute">
          {rows.length} {rows.length === 1 ? "item" : "items"}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="card p-10 text-center text-sm text-ink-mute">
          Trash is empty. Deleted entries land here and stay restorable for ~30 days.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-paper text-left text-xs text-ink-mute">
                <th className="px-4 py-2 font-medium">Collection</th>
                <th className="px-4 py-2 font-medium">Preview</th>
                <th className="px-4 py-2 font-medium">Deleted</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 font-medium text-ink-soft">{r.collection}</td>
                  <td className="px-4 py-2.5 text-ink-mute">{preview(r.data)}</td>
                  <td className="px-4 py-2.5 text-xs text-ink-mute">
                    {new Date(r.deletedAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    by {actorLabel(r.deletedBy)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <ConfirmButton
                        label="Restore"
                        pendingLabel="Restoring…"
                        action={restoreEntryAction.bind(null, projectId, r.collection, r.id)}
                      />
                      <ConfirmButton
                        label="Purge"
                        pendingLabel="Purging…"
                        confirmLabel="Confirm purge"
                        danger
                        arm
                        action={purgeEntryAction.bind(null, projectId, r.collection, r.id)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
