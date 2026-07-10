import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Globe, History, RotateCcw } from "lucide-react";
import { db } from "@/db";
import { entries, type AuditActor } from "@/db/schema";
import { getCollection } from "@/lib/collections";
import { listAuditLog } from "@/lib/audit";
import { listEntryVersions } from "@/lib/versions";
import { loadRelationChoices } from "@/lib/admin";
import { getLocales } from "@/lib/locales";
import { fieldLocalized } from "@/lib/field-types";
import { publicFields } from "@/lib/entries";
import { allowedTargets } from "@/lib/workflow";
import { EntryForm } from "@/components/EntryForm";
import { DeleteEntryButton } from "@/components/DeleteEntryButton";
import { ConfirmButton } from "@/components/ConfirmButton";
import { saveEntry, deleteEntryAction, restoreVersionAction } from "../../../actions";

/** Who performed an audit action, in client-readable words. */
function actorLabel(actor: AuditActor): string {
  switch (actor.type) {
    case "mcp":
      return "the agent";
    case "admin":
      return "an admin user";
    case "delivery":
      return actor.userSub ? "a signed-in site user" : "the public site";
    default:
      return "unknown";
  }
}

/** Edit an existing entry: auto-generated form + metadata/visibility panel. */
export default async function EditEntry({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; collection: string; entryId: string }>;
  searchParams: Promise<{ locale?: string }>;
}) {
  const { projectId, collection: name, entryId } = await params;
  const { locale: localeParam } = await searchParams;
  const collection = await getCollection(projectId, name);
  if (!collection) notFound();

  const [entry, relationChoices, audit, versionsPage, locales] = await Promise.all([
    db
      .select()
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.collectionId, collection.id)))
      .limit(1)
      .then((r) => r[0]),
    loadRelationChoices(projectId, collection.fields),
    listAuditLog(projectId, { entryId, limit: 8, offset: 0 }),
    listEntryVersions(projectId, entryId, { limit: 10 }),
    getLocales(projectId),
  ]);
  if (!entry) notFound();
  const versions = versionsPage.versions;

  // G5: a workflow field offers only the current state + admin-reachable
  // targets (UX truthfulness; the entries layer enforces).
  const wf = collection.workflow;
  const current = wf ? entry.data[wf.field] : undefined;
  const enumOptionOverrides =
    wf && typeof current === "string"
      ? { [wf.field]: [current, ...allowedTargets(wf, current, "admin").filter((t) => t !== current)] }
      : undefined;

  const pub = publicFields(collection).length;

  // J7: which locale's variants the form edits — ?locale=xx, validated against
  // the registry (unknown falls back to the default). Switcher shown only when
  // this collection actually has localized fields.
  const hasLocalized = collection.fields.some(fieldLocalized);
  const activeLocale =
    locales && localeParam && locales.supported.includes(localeParam.toLowerCase())
      ? localeParam.toLowerCase()
      : (locales?.default ?? null);

  return (
    <>
      <p className="mb-2 text-sm text-ink-mute">
        <Link href={`/admin/${projectId}/${name}`} className="hover:text-ink-soft">
          ← {collection.displayName}
        </Link>
      </p>
      <div className="mb-5 flex items-center">
        <h1 className="display text-xl font-semibold">Edit {collection.displayName}</h1>
        <div className="ml-auto">
          <DeleteEntryButton action={deleteEntryAction.bind(null, projectId, name, entryId)} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-[1.7fr_1fr]">
        <div>
          {hasLocalized && locales && (
            <div className="mb-4 flex items-center gap-1.5">
              <span className="section-label mr-1">Locale</span>
              {locales.supported.map((l) => (
                <Link
                  key={l}
                  href={`/admin/${projectId}/${name}/${entryId}?locale=${l}`}
                  className={l === activeLocale ? "chip chip-brand" : "chip chip-mute"}
                >
                  {l}
                  {l === locales.default ? " (default)" : ""}
                </Link>
              ))}
            </div>
          )}
          <EntryForm
            projectId={projectId}
            fields={collection.fields}
            relationChoices={relationChoices}
            initial={entry.data}
            action={saveEntry.bind(null, projectId, name, entryId)}
            enumOptionOverrides={enumOptionOverrides}
            locales={locales}
            activeLocale={activeLocale}
          />
        </div>
        <aside>
          <div className="rounded-xl border border-line bg-paper p-4 text-sm">
            <dl className="space-y-1.5">
              <div className="flex justify-between">
                <dt className="text-ink-mute">Created</dt>
                <dd>{entry.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-mute">Updated</dt>
                <dd>{entry.updatedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-mute">ID</dt>
                <dd className="font-mono text-xs text-ink-soft">{entry.id.slice(0, 8)}…</dd>
              </div>
            </dl>
            <div className="my-3 border-t border-line" />
            <div className="flex items-center gap-1.5 font-medium">
              <Globe className="h-4 w-4 text-ink-mute" />
              Visibility
            </div>
            <p className="mt-1 text-ink-mute">
              {pub} of {collection.fields.length} fields are public and served by{" "}
              <code className="font-mono text-xs">GET /v1/{name}</code>.
            </p>
            {audit.length > 0 && (
              <>
                <div className="my-3 border-t border-line" />
                <div className="flex items-center gap-1.5 font-medium">
                  <History className="h-4 w-4 text-ink-mute" />
                  History
                </div>
                <ul className="mt-1.5 space-y-1.5">
                  {audit.slice(0, 8).map((row, i) => (
                    <li key={i} className="text-xs leading-relaxed text-ink-mute">
                      <span className="font-medium text-ink-soft">
                        {row.action === "create"
                          ? "Created"
                          : row.action === "delete"
                            ? "Deleted"
                            : row.action === "restore"
                              ? "Restored"
                              : row.action === "purge"
                                ? "Purged"
                                : "Updated"}
                      </span>{" "}
                      by {actorLabel(row.actor)}
                      {row.action === "update" && row.changedFields?.length
                        ? ` — ${row.changedFields.join(", ")}`
                        : ""}
                      <span className="text-line-strong">
                        {" · "}
                        {row.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}{" "}
                        {row.createdAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {versions.length > 0 && (
              <>
                <div className="my-3 border-t border-line" />
                <div className="flex items-center gap-1.5 font-medium">
                  <RotateCcw className="h-4 w-4 text-ink-mute" />
                  Versions
                </div>
                <p className="mt-1 text-xs text-ink-mute">
                  Restore rolls this entry back to a past state (itself undoable).
                </p>
                <ul className="mt-1.5 space-y-2">
                  {versions.map((v) => (
                    <li key={v.versionId} className="flex items-center justify-between gap-2">
                      <span className="text-xs leading-relaxed text-ink-mute">
                        {new Date(v.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}{" "}
                        {new Date(v.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        {v.changedFields?.length ? (
                          <span className="text-line-strong"> · {v.changedFields.join(", ")}</span>
                        ) : null}
                      </span>
                      <ConfirmButton
                        label="Restore"
                        pendingLabel="Restoring…"
                        confirmLabel="Confirm"
                        arm
                        action={restoreVersionAction.bind(null, projectId, name, entryId, v.versionId)}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
