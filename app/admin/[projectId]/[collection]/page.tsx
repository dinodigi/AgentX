import Link from "next/link";
import { notFound } from "next/navigation";
import { Check, Plus, Search, Undo2 } from "lucide-react";
import { getCollection } from "@/lib/collections";
import { queryEntries, countEntries, resolveRefsForRead } from "@/lib/entries";
import { getLocales } from "@/lib/locales";
import { fieldLocalized, type FieldDef } from "@/lib/field-types";
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
  // Quick filter: contains on the first text-ish field (localized fields have
  // no single-string accessor, so they can't back the quick search — J4).
  const searchField = collection.fields.find(
    (f) => (f.type === "text" || f.type === "richtext") && !fieldLocalized(f),
  );
  const where =
    q && searchField ? [{ field: searchField.name, op: "contains" as const, value: q }] : [];

  const [rows, total, locales] = await Promise.all([
    queryEntries(collection, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, where }).then(
      (r) => resolveRefsForRead(projectId, collection, r, "trusted"),
    ),
    countEntries(collection, where),
    getLocales(projectId),
  ]);
  const defaultLocale = locales?.default ?? null;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // First 4 fields as columns keeps the table readable at any schema size.
  const cols = collection.fields.slice(0, 4);
  const pageHref = (p: number) =>
    `/admin/${projectId}/${name}?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-3">
        <div className="mr-auto flex items-baseline gap-3">
          <h1 className="display text-xl font-semibold">{collection.displayName}</h1>
          <span className="font-mono text-[11px] text-ink-mute">
            {total} {total === 1 ? "entry" : "entries"}
          </span>
        </div>
        {searchField && (
          <form className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-line-strong" />
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder={`Search ${searchField.label.toLowerCase()}…`}
              className="field-input h-9 w-56 !py-1.5 pl-8 font-mono text-[12px]"
            />
          </form>
        )}
        <div className="flex items-center overflow-hidden rounded-md border border-line">
          <a
            href={`/api/admin/export-entries?projectId=${projectId}&collection=${name}&format=csv`}
            className="px-2.5 py-[7px] font-mono text-[11px] text-ink-mute transition-colors hover:bg-raised hover:text-ink"
            title="Download all entries as CSV"
            download
          >
            CSV
          </a>
          <span className="h-4 w-px bg-line" />
          <a
            href={`/api/admin/export-entries?projectId=${projectId}&collection=${name}&format=json`}
            className="px-2.5 py-[7px] font-mono text-[11px] text-ink-mute transition-colors hover:bg-raised hover:text-ink"
            title="Download all entries as JSON"
            download
          >
            JSON
          </a>
        </div>
        <Link href={`/admin/${projectId}/${name}/new`} className="btn btn-primary">
          <Plus className="h-4 w-4" />
          New entry
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="card p-10 text-center text-sm text-ink-mute">
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
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-line text-left">
                {collection.publicWrite && <th className="table-head px-4 py-3">Status</th>}
                {cols.map((f) => (
                  <th key={f.name} className="table-head px-4 py-3">
                    {f.label}
                  </th>
                ))}
                <th className="table-head px-4 py-3 text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="group border-b border-line transition-colors last:border-0 hover:bg-raised"
                >
                  {collection.publicWrite && (
                    <td className="px-4 py-3">
                      <form action={toggleHandledAction.bind(null, projectId, name, r.id)}>
                        {r.handledAt ? (
                          <button type="submit" className="chip chip-mute transition-opacity hover:opacity-70" title="Mark as new again">
                            <Undo2 className="h-3 w-3" />
                            handled
                          </button>
                        ) : (
                          <button type="submit" className="chip chip-brand transition-opacity hover:opacity-70" title="Mark handled">
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
                          className="font-medium transition-colors group-hover:text-brand-strong"
                        >
                          <Cell field={f} value={r.data[f.name]} defaultLocale={defaultLocale} />
                        </Link>
                      ) : (
                        <Cell field={f} value={r.data[f.name]} defaultLocale={defaultLocale} />
                      )}
                    </td>
                  ))}
                  <td className="px-4 py-3 text-right font-mono text-[11px] text-ink-mute">
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
          <span className="text-ink-mute">
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
function Cell({
  field,
  value,
  defaultLocale,
}: {
  field: FieldDef;
  value: unknown;
  defaultLocale?: string | null;
}) {
  // J4: a localized value is a {locale: string} variant map — show the default
  // locale's variant, never "[object Object]".
  if (fieldLocalized(field) && value && typeof value === "object" && !Array.isArray(value)) {
    value = (value as Record<string, unknown>)[defaultLocale ?? ""] ?? null;
  }
  if (value == null || value === "") return <span className="text-line-strong">—</span>;

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
      return <span className="text-ink-soft">{label}</span>;
    }
    case "date":
      return (
        <span className="text-ink-soft">
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
        <span className="text-xs text-ink-mute">file</span>
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
