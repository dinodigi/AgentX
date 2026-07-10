import Link from "next/link";
import { notFound } from "next/navigation";
import { getCollection } from "@/lib/collections";
import { loadRelationChoices } from "@/lib/admin";
import { getLocales } from "@/lib/locales";
import { EntryForm } from "@/components/EntryForm";
import { saveEntry } from "../../../actions";

/** Create a new entry using the auto-generated form. */
export default async function NewEntry({
  params,
}: {
  params: Promise<{ projectId: string; collection: string }>;
}) {
  const { projectId, collection: name } = await params;
  const collection = await getCollection(projectId, name);
  if (!collection) notFound();

  const [relationChoices, locales] = await Promise.all([
    loadRelationChoices(projectId, collection.fields),
    getLocales(projectId),
  ]);
  const action = saveEntry.bind(null, projectId, name, null);

  // G5: a new entry's workflow field is pinned to the initial state — the
  // create rule enforces it anyway; the form just tells the truth.
  const wf = collection.workflow;
  const enumOptionOverrides = wf ? { [wf.field]: [wf.initial] } : undefined;

  return (
    <>
      <p className="mb-2 text-sm text-[--color-ink-mute]">
        <Link href={`/admin/${projectId}/${name}`} className="hover:text-[--color-ink-soft]">
          ← {collection.displayName}
        </Link>
      </p>
      <h1 className="display mb-5 text-xl font-semibold">New {collection.displayName}</h1>
      <div className="max-w-lg">
        <EntryForm
          projectId={projectId}
          fields={collection.fields}
          relationChoices={relationChoices}
          initial={{}}
          action={action}
          enumOptionOverrides={enumOptionOverrides}
          // J7: new entries are pinned to the default locale — required
          // localized fields need the default variant; translate after create.
          locales={locales}
          activeLocale={locales?.default ?? null}
        />
      </div>
    </>
  );
}
