import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { getCollection } from "@/lib/collections";
import { queryEntries, resolveRelations } from "@/lib/entries";
import type { FieldDef } from "@/lib/field-types";

/** Entry list for a collection — auto-generated table, columns from field defs. */
export default async function CollectionEntries({
  params,
}: {
  params: Promise<{ projectId: string; collection: string }>;
}) {
  const { projectId, collection: name } = await params;
  const collection = await getCollection(projectId, name);
  if (!collection) notFound();

  const rows = await resolveRelations(
    projectId,
    collection,
    await queryEntries(collection, { limit: 200 }),
  );
  // First 4 fields as columns keeps the table readable at any schema size.
  const cols = collection.fields.slice(0, 4);

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg font-medium">{collection.displayName}</h1>
        <span className="text-sm text-gray-400">{rows.length} entries</span>
        <Link
          href={`/admin/${projectId}/${name}/new`}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-strong"
        >
          <Plus className="h-4 w-4" />
          New entry
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-500">
          No entries yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
                {cols.map((f) => (
                  <th key={f.name} className="px-3 py-2 font-medium">
                    {f.label}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  {cols.map((f, i) => (
                    <td key={f.name} className="px-3 py-2.5">
                      {i === 0 ? (
                        <Link
                          href={`/admin/${projectId}/${name}/${r.id}`}
                          className="font-medium text-gray-900 hover:text-brand-strong"
                        >
                          <Cell field={f} value={r.data[f.name]} />
                        </Link>
                      ) : (
                        <Cell field={f} value={r.data[f.name]} />
                      )}
                    </td>
                  ))}
                  <td className="px-3 py-2.5 text-gray-400">
                    {r.updatedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
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

/** Type-aware cell rendering — one representation per primitive. */
function Cell({ field, value }: { field: FieldDef; value: unknown }) {
  if (value == null || value === "") return <span className="text-gray-300">—</span>;

  switch (field.type) {
    case "boolean":
      return value ? (
        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs text-brand-strong">Yes</span>
      ) : (
        <span className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-500">No</span>
      );
    case "enum":
      return (
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
          {String(value)}
        </span>
      );
    case "relation": {
      const label =
        value && typeof value === "object" && "label" in value
          ? String((value as { label: unknown }).label)
          : String(value);
      return <span className="text-gray-600">{label}</span>;
    }
    case "date":
      return (
        <span className="text-gray-600">
          {new Date(String(value)).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </span>
      );
    case "asset":
      return <span className="text-xs text-gray-400">file</span>;
    case "richtext": {
      const text = String(value).replace(/<[^>]+>/g, "");
      return <span>{text.length > 60 ? text.slice(0, 60) + "…" : text}</span>;
    }
    default: {
      const s = String(value);
      return <span>{s.length > 60 ? s.slice(0, 60) + "…" : s}</span>;
    }
  }
}
