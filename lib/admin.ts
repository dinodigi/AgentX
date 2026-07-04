import "server-only";
import { eq } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/db";
import { projects, type Project } from "@/db/schema";
import { getCollection } from "./collections";
import { queryEntries } from "./entries";
import type { FieldDef } from "./field-types";
import type { RelationChoice } from "@/components/EntryForm";

/** Project metadata, cached; revalidateTag(`project:{id}`) on branding edits. */
export async function getProject(projectId: string): Promise<Project | null> {
  const cached = unstable_cache(
    () => db.select().from(projects).where(eq(projects.id, projectId)).limit(1),
    ["project", projectId],
    { tags: [`project:${projectId}`] },
  );
  const rows = await cached();
  if (!rows[0]) return null;
  return { ...rows[0], createdAt: new Date(rows[0].createdAt) };
}

/**
 * For each relation field, load selectable choices from its target collection,
 * labeled by labelField. All relation fields load in parallel.
 */
export async function loadRelationChoices(
  projectId: string,
  fields: FieldDef[],
): Promise<Record<string, RelationChoice[]>> {
  const relationFields = fields.filter(
    (f): f is Extract<FieldDef, { type: "relation" }> => f.type === "relation",
  );
  const loaded = await Promise.all(
    relationFields.map(async (f) => {
      const target = await getCollection(projectId, f.targetCollection);
      if (!target) return [f.name, []] as const;
      const rows = await queryEntries(target, { limit: 500 });
      return [
        f.name,
        rows.map((r) => ({ id: r.id, label: String(r.data[f.labelField] ?? r.id) })),
      ] as const;
    }),
  );
  return Object.fromEntries(loaded);
}
