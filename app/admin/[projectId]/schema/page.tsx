import { notFound } from "next/navigation";
import { getProject } from "@/lib/admin";
import { listCollections } from "@/lib/collections";
import { layoutSchemaMap, summarize, type MapCollection, type MapMode } from "@/lib/schema-map";
import { SchemaMap } from "@/components/admin/SchemaMap";

/**
 * Schema map — the project's content model drawn from its own definition.
 *
 * Access is already settled by the project layout, which resolves the viewer's
 * rung and renders a reason-bearing panel instead of a bare 404 when it cannot
 * (DX-8). This page therefore does no access work of its own; it only needs the
 * project to exist, which `getProject` answers.
 *
 * Reads through listCollections, the same fresh-read path the MCP surface uses,
 * so a schema change is visible here immediately rather than after a cache TTL.
 */
export default async function SchemaPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { projectId } = await params;
  const { view } = await searchParams;
  const [project, collections] = await Promise.all([getProject(projectId), listCollections(projectId)]);
  if (!project) notFound();

  const mode: MapMode = view === "public" ? "public" : "model";

  // Narrow the stored definition to what the layout needs. Container fields keep
  // their type so they draw as one collapsed row — expanding a blocks field can
  // dwarf its own collection, which makes the map less legible, not more.
  const input: MapCollection[] = collections.map((c) => ({
    name: c.name,
    publicWrite: c.publicWrite === true,
    hasAccessRules: c.access != null && Object.keys(c.access as object).length > 0,
    fields: (c.fields ?? []).map((f) => ({
      name: f.name,
      type: f.type,
      targetCollection: f.type === "relation" ? f.targetCollection : undefined,
      unique: f.unique === true,
      indexed: f.indexed === true,
      // `searchable` exists only on the text/richtext members of the union.
      searchable: "searchable" in f && f.searchable === true,
      publicRead: f.publicRead === true,
    })),
  }));

  const layout = layoutSchemaMap(input, mode);

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-8">
      <SchemaMap layout={layout} mode={mode} projectId={projectId} summary={summarize(layout)} />
    </div>
  );
}
