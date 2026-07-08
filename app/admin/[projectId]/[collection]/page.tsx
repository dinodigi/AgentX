import Link from "next/link";
import { notFound } from "next/navigation";
import { Check, Download, Plus, Undo2 } from "lucide-react";
import { getCollection } from "@/lib/collections";
import { queryEntries, countEntries, resolveRefsForRead } from "@/lib/entries";
import type { FieldDef } from "@/lib/field-types";
import { toggleHandledAction } from "../../actions";

const PAGE_SIZE = 50;

/** Entry list for a collection — auto-generated table, columns from field defs. */
export default async function CollectionEntries({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; collection: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { projectId, collection: name } = await params;
  const { q, page: pageParam } = await searchParams;
  const collection = await getCollection(projectId, name);
  if (!collection) notFound();

  const page = Math.max(1, Number(pageParam ?? 1) || 1);
  // Quick filter: contains on the first text-ish field.
  const searchField = collection.fields.find((f) => f.type === "text" || f.type === "richtext");
  const where =
    q && searchField ? [{ field: searchField.name, op: "contains" as const, value: q }] : [];

  const [rows, total] = await Promise.all([
    queryEntries(collection, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, where }).then(
      (r) => resolveRefsForRead(projectId, collection, r, "trusted"),
    ),
    countEntries(collection, where),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // First 4 fields as columns keeps the table readable at any schema size.
  const cols = collection.fields.slice(0, 4);
  const pageHref = (p: number) =>
    `/admin/${projectId}/${name}?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;

  return (
    <>
      <div className="mb-5 flex items-center gap-3">
        <h1 className="display text-xl font-semibold">{collection.displayName}</h1>
        <span className="text-sm text-[--color-ink-mute]">{total} entries</span>
        {searchField && (
          <form className="ml-2">
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder={`Search ${searchField.label.toLowerCase()}…`}
              className="field-input w-48 !py-1.5"
            />
          </form>
        )}
        <a
          href={`/api/admin/export-entries?projectId=${projectId}&collection=${name}&format=csv`}
          className="btn ml-auto"
          title="Download all entries as CSV"
          download
        >
          <Download className="h-4 w-4" />
          CSV
        </a>
        <a
          href={`/api/admin/export-entries?projectId=${projectId}&collection=${name}&format=json`}
          className="btn"
          title="Download all entries as JSON"
          download
        >
          JSON
        </a>
        <Link href={`/admin/${projectId}/${name}/new`} className="btn btn-primary">
          <Plus className="h-4 w-4" />
          New entry
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="card p-10 text-center text-sm text-[--color-ink-mute]">
          {q ? (
            "No matches."
          ) : collection.publicWrite ? (
            <>
              No submissions yet. Your site posts to{" "}
              <code className="font-mono text-xs">POST /v1/{name}</code> — new ones land here
              with a <span className="chip chip-brand">new</span> badge.
            </>
          ) : (
            <>
              No entries yet — create one with <span className="font-medium">New entry</span>,
              or let your agent seed the collection over MCP
              (<code className="font-mono text-xs">bulk_create_entries</code>).
            </>
          )}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[--color-line] text-left">
                {collection.publicWrite && <th className="table-head px-4 py-2.5">Status</th>}
                {cols.map((f) => (
                  <th key={f.name} className="table-head px-4 py-2.5">
                    {f.label}
                  </th>
                ))}
                <th className="table-head px-4 py-2.5">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-[--color-line] transition-colors last:border-0 hover:bg-[--color-brand-wash] ${
                    collection.publicWrite && !r.handledAt ? "bg-[--color-brand-wash]/40" : ""
                  }`}
                >
                  {collection.publicWrite && (
                    <td className="px-4 py-3">
                      <form action={toggleHandledAction.bind(null, projectId, name, r.id)}>
                        {r.handledAt ? (
                          <button
                            type="submit"
                            className="chip chip-mute transition-opacity hover:opacity-70"
                            title="Mark as new again"
                          >
                            <Undo2 className="h-3 w-3" />
                            handled
                          </button>
                        ) : (
                          <button
                            type="submit"
                            className="chip chip-brand transition-opacity hover:opacity-70"
                            title="Mark handled"
                          >
                            <Check className="h-3 w-3" />
                            new
                          </button>
                        )}
                      </form>
                    </td>
                  )}
                  {cols.map((f, i) => (
                    <td key={f.name} className="px-4 py-3">
                      {i === 0 ? (
                        <Link
                          href={`/admin/${projectId}/${name}/${r.id}`}
                          className="font-medium hover:text-brand-strong"
                        >
                          <Cell field={f} value={r.data[f.name]} />
                        </Link>
                      ) : (
                        <Cell field={f} value={r.data[f.name]} />
                      )}
                    </td>
                  ))}
                  <td className="px-4 py-3 text-[--color-ink-mute]">
                    {r.updatedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="mt-4 flex items-center gap-3 text-sm">
          {page > 1 && (
            <Link href={pageHref(page - 1)} className="btn">
              ← Prev
            </Link>
          )}
          <span className="text-[--color-ink-mute]">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <Link href={pageHref(page + 1)} className="btn">
              Next →
            </Link>
          )}
        </div>
      )}
    </>
  );
}

/** Type-aware cell rendering — one representation per primitive. */
function Cell({ field, value }: { field: FieldDef; value: unknown }) {
  if (value == null || value === "") return <span className="text-[--color-line-strong]">—</span>;

  switch (field.type) {
    case "boolean":
      return value ? (
        <span className="chip chip-brand">Yes</span>
      ) : (
        <span className="chip chip-mute">No</span>
      );
    case "enum":
      return (
        <span className="chip chip-mute">
          {String(value)}
        </span>
      );
    case "relation": {
      const label =
        value && typeof value === "object" && "label" in value
          ? String((value as { label: unknown }).label)
          : String(value);
      return <span className="text-[--color-ink-soft]">{label}</span>;
    }
    case "date":
      return (
        <span className="text-[--color-ink-soft]">
          {new Date(String(value)).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </span>
      );
    case "asset": {
      const url =
        value && typeof value === "object" && "url" in value
          ? String((value as { url: unknown }).url)
          : null;
      return url && /\.(png|jpe?g|gif|webp|svg)$/i.test(url) ? (
        <img src={url} alt="" className="h-8 w-8 rounded object-cover" />
      ) : (
        <span className="text-xs text-[--color-ink-mute]">file</span>
      );
    }
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
