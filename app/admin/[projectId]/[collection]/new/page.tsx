import Link from "next/link";
import { notFound } from "next/navigation";
import { getCollection } from "@/lib/collections";
import { loadRelationChoices } from "@/lib/admin";
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

  const relationChoices = await loadRelationChoices(projectId, collection.fields);
  const action = saveEntry.bind(null, projectId, name, null);

  return (
    <>
      <p className="mb-2 text-sm text-gray-400">
        <Link href={`/admin/${projectId}/${name}`} className="hover:text-gray-600">
          ← {collection.displayName}
        </Link>
      </p>
      <h1 className="mb-5 text-lg font-medium">New {collection.displayName}</h1>
      <div className="max-w-lg">
        <EntryForm
          projectId={projectId}
          fields={collection.fields}
          relationChoices={relationChoices}
          initial={{}}
          action={action}
        />
      </div>
    </>
  );
}
