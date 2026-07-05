import { z } from "zod";
import { eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { db } from "@/db";
import { projects, type Branding } from "@/db/schema";
import { getProject } from "./admin";
import {
  listCollections,
  defineCollection,
  type SchemaDiff,
} from "./collections";
import type { FieldDef } from "./field-types";
import { WHERE_OPS, type WhereClause } from "./query";
import { ValidationError } from "./validation";

/**
 * Project manifest: the entire project definition (branding + collections) as
 * one JSON document. Infrastructure-as-data — agents can version it in git,
 * diff it, and replicate a project from it. Entries and secrets are NOT part
 * of a manifest.
 */

export interface ProjectManifest {
  version: 1;
  project: { name: string; branding: Branding };
  collections: {
    name: string;
    displayName: string;
    publicWrite: boolean;
    webhookUrl: string | null;
    publicFilter: WhereClause[] | null;
    access: { read?: "public" | "authenticated" | "owner"; write?: "none" | "authenticated" | "owner"; ownerField?: string } | null;
    events: Record<string, unknown> | null;
    fields: FieldDef[];
  }[];
}

const manifestSchema = z.object({
  version: z.literal(1),
  project: z.object({
    name: z.string().min(1),
    branding: z
      .object({
        displayName: z.string().optional(),
        logoUrl: z.string().optional(),
        primaryColor: z.string().optional(),
      })
      .default({}),
  }),
  collections: z.array(
    z.object({
      name: z.string(),
      displayName: z.string(),
      publicWrite: z.boolean().default(false),
      webhookUrl: z.string().nullable().default(null),
      publicFilter: z
        .array(
          z.object({
            field: z.string(),
            op: z.enum(WHERE_OPS),
            value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
          }),
        )
        .nullable()
        .default(null),
      access: z
        .object({
          read: z.enum(["public", "authenticated", "owner"]).optional(),
          write: z.enum(["none", "authenticated", "owner"]).optional(),
          ownerField: z.string().optional(),
        })
        .nullable()
        .default(null),
      events: z.record(z.unknown()).nullable().default(null),
      fields: z.array(z.any()),
    }),
  ),
});

export async function exportProject(projectId: string): Promise<ProjectManifest> {
  const [project, collections] = await Promise.all([
    getProject(projectId),
    listCollections(projectId),
  ]);
  if (!project) throw new ValidationError("project not found", "E_NOT_FOUND");

  return {
    version: 1,
    project: { name: project.name, branding: project.branding },
    collections: collections.map((c) => ({
      name: c.name,
      displayName: c.displayName,
      publicWrite: c.publicWrite,
      webhookUrl: c.webhookUrl,
      publicFilter: c.publicFilter ?? null,
      access: c.access ?? null,
      events: c.events ?? null,
      fields: c.fields,
    })),
  };
}

/** Order collections so relation targets are defined before their dependents. */
function topoSort(cols: ProjectManifest["collections"]): ProjectManifest["collections"] {
  const byName = new Map(cols.map((c) => [c.name, c]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: ProjectManifest["collections"][number][] = [];

  function visit(name: string, chain: string[]) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      // Relation cycles are legal at runtime (targets exist after full import),
      // so break the cycle rather than failing — second collection's target
      // check passes because the first was just created.
      return;
    }
    const col = byName.get(name);
    if (!col) return;
    visiting.add(name);
    for (const f of col.fields as FieldDef[]) {
      if (f.type === "relation" && byName.has(f.targetCollection)) {
        visit(f.targetCollection, [...chain, name]);
      }
    }
    visiting.delete(name);
    visited.add(name);
    out.push(col);
  }

  for (const c of cols) visit(c.name, []);
  return out;
}

export interface ImportResult {
  applied: string[];
  /** Collections whose destructive changes need confirm: true. */
  pendingPlans: { collection: string; plan: SchemaDiff }[];
  brandingUpdated: boolean;
}

/**
 * Apply a manifest to the current project. Idempotent: unchanged collections
 * are no-ops, destructive changes surface plans unless confirm is set.
 */
export async function importProject(
  projectId: string,
  rawManifest: unknown,
  confirm = false,
): Promise<ImportResult> {
  const parsed = manifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    throw new ValidationError(
      "invalid manifest: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const manifest = parsed.data;

  await db
    .update(projects)
    .set({ branding: manifest.project.branding })
    .where(eq(projects.id, projectId));
  revalidateTag(`project:${projectId}`);

  const applied: string[] = [];
  const pendingPlans: ImportResult["pendingPlans"] = [];

  for (const col of topoSort(manifest.collections as ProjectManifest["collections"])) {
    const result = await defineCollection(projectId, {
      name: col.name,
      displayName: col.displayName,
      fields: col.fields as FieldDef[],
      publicWrite: col.publicWrite,
      webhookUrl: col.webhookUrl,
      publicFilter: col.publicFilter,
      access: col.access,
      events: col.events as never,
      confirm,
    });
    if (result.applied) applied.push(col.name);
    else pendingPlans.push({ collection: col.name, plan: result.diff });
  }

  return { applied, pendingPlans, brandingUpdated: true };
}
