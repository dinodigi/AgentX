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
      <p className="mb-6 text-sm text-gray-500">
        All requests need the project token:{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">
          Authorization: Bearer agx_…
        </code>
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

function CollectionDocs({ collection }: { collection: Collection }) {
  const pub = publicFields(collection);

  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <p className="mb-3 font-medium">{collection.displayName}</p>

      {pub.length > 0 ? (
        <div className="mb-4">
          <p className="mb-1.5 text-sm">
            <span className="mr-2 rounded bg-brand-soft px-1.5 py-0.5 font-mono text-xs font-medium text-brand-strong">
              GET
            </span>
            <code className="font-mono text-sm">/api/v1/{collection.name}</code>
          </p>
          <p className="mb-2 text-xs text-gray-500">
            Returns only the public fields. Relations resolve to{" "}
            <code className="font-mono">{"{ id, label }"}</code>.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-gray-50 p-3 font-mono text-xs leading-relaxed text-gray-700">
            {sampleResponse(collection.name, pub)}
          </pre>
        </div>
      ) : (
        <p className="mb-4 text-xs text-gray-400">
          No public fields — this collection is not readable from the delivery API.
        </p>
      )}

      {collection.publicWrite && (
        <div>
          <p className="mb-1.5 text-sm">
            <span className="mr-2 rounded bg-amber-50 px-1.5 py-0.5 font-mono text-xs font-medium text-amber-800">
              POST
            </span>
            <code className="font-mono text-sm">/api/v1/{collection.name}</code>
          </p>
          <p className="mb-2 text-xs text-gray-500">
            Public write is on — submissions are validated, stored, and fire the
            webhook. Required fields:{" "}
            {collection.fields
              .filter((f) => f.required)
              .map((f) => f.name)
              .join(", ") || "none"}
            .
          </p>
          <pre className="overflow-x-auto rounded-lg bg-gray-50 p-3 font-mono text-xs leading-relaxed text-gray-700">
            {samplePayload(collection.fields)}
          </pre>
        </div>
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
      return "asset-uuid";
    case "relation":
      return { id: "entry-uuid", label: "…" };
  }
}

function sampleResponse(name: string, fields: FieldDef[]): string {
  const row: Record<string, unknown> = { id: "entry-uuid" };
  for (const f of fields) row[f.name] = sampleValue(f);
  return JSON.stringify({ data: [row] }, null, 2);
}

function samplePayload(fields: FieldDef[]): string {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === "relation") body[f.name] = "entry-uuid";
    else body[f.name] = sampleValue(f);
  }
  return JSON.stringify(body, null, 2);
}
