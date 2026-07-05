import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { Globe } from "lucide-react";
import { db } from "@/db";
import { entries } from "@/db/schema";
import { getCollection } from "@/lib/collections";
import { loadRelationChoices } from "@/lib/admin";
import { publicFields } from "@/lib/entries";
import { EntryForm } from "@/components/EntryForm";
import { DeleteEntryButton } from "@/components/DeleteEntryButton";
import { saveEntry, deleteEntryAction } from "../../../actions";

/** Edit an existing entry: auto-generated form + metadata/visibility panel. */
export default async function EditEntry({
  params,
}: {
  params: Promise<{ projectId: string; collection: string; entryId: string }>;
}) {
  const { projectId, collection: name, entryId } = await params;
  const collection = await getCollection(projectId, name);
  if (!collection) notFound();

  const [entry, relationChoices] = await Promise.all([
    db
      .select()
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.collectionId, collection.id)))
      .limit(1)
      .then((r) => r[0]),
    loadRelationChoices(projectId, collection.fields),
  ]);
  if (!entry) notFound();

  const pub = publicFields(collection).length;

  return (
    <>
      <p className="mb-2 text-sm text-[--color-ink-mute]">
        <Link href={`/admin/${projectId}/${name}`} className="hover:text-[--color-ink-soft]">
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
          <EntryForm
            projectId={projectId}
            fields={collection.fields}
            relationChoices={relationChoices}
            initial={entry.data}
            action={saveEntry.bind(null, projectId, name, entryId)}
          />
        </div>
        <aside>
          <div className="rounded-xl border border-[--color-line] bg-[--color-paper] p-4 text-sm">
            <dl className="space-y-1.5">
              <div className="flex justify-between">
                <dt className="text-[--color-ink-mute]">Created</dt>
                <dd>{entry.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[--color-ink-mute]">Updated</dt>
                <dd>{entry.updatedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[--color-ink-mute]">ID</dt>
                <dd className="font-mono text-xs text-[--color-ink-soft]">{entry.id.slice(0, 8)}…</dd>
              </div>
            </dl>
            <div className="my-3 border-t border-[--color-line]" />
            <div className="flex items-center gap-1.5 font-medium">
              <Globe className="h-4 w-4 text-[--color-ink-mute]" />
              Visibility
            </div>
            <p className="mt-1 text-[--color-ink-mute]">
              {pub} of {collection.fields.length} fields are public and served by{" "}
              <code className="font-mono text-xs">GET /v1/{name}</code>.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
