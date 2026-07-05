import { listCollections } from "@/lib/collections";
import { publicFields } from "@/lib/entries";
import type { Collection } from "@/db/schema";
import type { FieldDef } from "@/lib/field-types";

/**
 * Auto-generated API reference — rendered straight from the schema registry.
 * What a site developer reads to wire the front end; zero maintenance.
 */
export default async function ApiReference({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const collections = await listCollections(projectId);

  return (
    <>
      <h1 className="mb-1 text-lg font-medium">API reference</h1>
      <p className="mb-2 text-sm text-gray-500">
        All requests need a project token (use a delivery-scoped one in sites):{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">
          Authorization: Bearer agx_…
        </code>
      </p>
      <p className="mb-6 text-sm text-gray-500">
        Collections with access rules also need the signed-in user&apos;s JWT:{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">
          X-User-Token: &lt;jwt&gt;
        </code>{" "}
        — issued by this project&apos;s connected Clerk instance.
      </p>

      {collections.length === 0 && (
        <p className="rounded-lg border border-gray-200 p-4 text-sm text-gray-400">
          No collections defined yet.
        </p>
      )}

      <div className="space-y-6">
        {collections.map((c) => (
          <CollectionDocs key={c.name} collection={c} />
        ))}
      </div>
    </>
  );
}

function Method({ verb, tone }: { verb: string; tone: "get" | "post" | "mut" }) {
  const cls =
    tone === "get"
      ? "bg-brand-soft text-brand-strong"
      : tone === "post"
        ? "bg-amber-50 text-amber-800"
        : "bg-gray-100 text-gray-700";
  return (
    <span className={`mr-2 rounded px-1.5 py-0.5 font-mono text-xs font-medium ${cls}`}>
      {verb}
    </span>
  );
}

function CollectionDocs({ collection }: { collection: Collection }) {
  const pub = publicFields(collection);
  const read = collection.access?.read ?? "public";
  const write = collection.access?.write ?? "none";
  const eventCount = ["created", "updated", "deleted"].reduce(
    (n, k) => n + (collection.events?.[k as "created"]?.length ?? 0),
    0,
  );

  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="font-medium">{collection.displayName}</p>
        {read !== "public" && (
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs text-brand-strong">
            read: {read}
          </span>
        )}
        {write !== "none" && (
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs text-brand-strong">
            write: {write}
          </span>
        )}
        {collection.publicFilter?.length ? (
          <span className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-500">
            row filter: {collection.publicFilter.map((f) => `${f.field} ${f.op} ${f.value}`).join(", ")}
          </span>
        ) : null}
        {eventCount > 0 && (
          <span className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-500">
            {eventCount} event action{eventCount > 1 ? "s" : ""}
          </span>
        )}
      </div>

      {pub.length > 0 ? (
        <div className="mb-4">
          <p className="mb-1.5 text-sm">
            <Method verb="GET" tone="get" />
            <code className="font-mono text-sm">/api/v1/{collection.name}</code>
          </p>
          <p className="mb-2 text-xs text-gray-500">
            Public fields only{read === "owner" ? ", scoped to the signed-in user's rows" : ""}.
            Relations → <code className="font-mono">{"{id,label}"}</code>, assets →{" "}
            <code className="font-mono">{"{id,url}"}</code>. Filters:{" "}
            <code className="font-mono">?{pub[0]?.name}=value</code> · sort:{" "}
            <code className="font-mono">?sort={pub[0]?.name}:asc</code> · paging:{" "}
            <code className="font-mono">?limit=&offset=</code>
          </p>
          <pre className="overflow-x-auto rounded-lg bg-gray-50 p-3 font-mono text-xs leading-relaxed text-gray-700">
            {sampleResponse(pub)}
          </pre>
          <p className="mt-1.5 text-xs text-gray-500">
            <Method verb="GET" tone="get" />
            <code className="font-mono">/api/v1/{collection.name}/{"{id}"}</code> — single entry,
            same rules.
          </p>
        </div>
      ) : (
        <p className="mb-4 text-xs text-gray-400">
          No public fields — this collection is not readable from the delivery API.
        </p>
      )}

      {(collection.publicWrite || write !== "none") && (
        <div className="mb-1">
          <p className="mb-1.5 text-sm">
            <Method verb="POST" tone="post" />
            <code className="font-mono text-sm">/api/v1/{collection.name}</code>
          </p>
          <p className="mb-2 text-xs text-gray-500">
            {collection.publicWrite && write === "none"
              ? "Anonymous submissions allowed (public form)."
              : `Requires a signed-in user (X-User-Token)${
                  collection.access?.ownerField
                    ? `; ${collection.access.ownerField} is stamped from the verified user`
                    : ""
                }.`}{" "}
            Validated server-side; fires event actions. Required:{" "}
            {collection.fields.filter((f) => f.required).map((f) => f.name).join(", ") || "none"}.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-gray-50 p-3 font-mono text-xs leading-relaxed text-gray-700">
            {samplePayload(collection.fields)}
          </pre>
        </div>
      )}

      {write === "owner" && (
        <p className="mt-2 text-xs text-gray-500">
          <Method verb="PATCH" tone="mut" />
          <Method verb="DELETE" tone="mut" />
          <code className="font-mono">/api/v1/{collection.name}/{"{id}"}</code> — signed-in owner
          only; ownership cannot be transferred.
        </p>
      )}
    </div>
  );
}

function sampleValue(f: FieldDef): unknown {
  switch (f.type) {
    case "text":
      return "…";
    case "richtext":
      return "<p>…</p>";
    case "number":
      return 42;
    case "boolean":
      return true;
    case "date":
      return "2026-07-04T12:00:00Z";
    case "enum":
      return f.options[0];
    case "asset":
      return { id: "asset-uuid", url: "https://…" };
    case "relation":
      return { id: "entry-uuid", label: "…" };
  }
}

function sampleResponse(fields: FieldDef[]): string {
  const row: Record<string, unknown> = { id: "entry-uuid" };
  for (const f of fields) row[f.name] = sampleValue(f);
  return JSON.stringify({ data: [row] }, null, 2);
}

function samplePayload(fields: FieldDef[]): string {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === "relation" || f.type === "asset") body[f.name] = "uuid";
    else body[f.name] = sampleValue(f);
  }
  return JSON.stringify(body, null, 2);
}
