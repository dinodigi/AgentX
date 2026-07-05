import { and, count, eq, sql } from "drizzle-orm";
import { unstable_cache, revalidateTag } from "next/cache";
import { db } from "@/db";
import { collections, entries, type Collection, type EventAction } from "@/db/schema";
import { getConnector } from "./connectors";
import { ValidationError } from "./validation";
import { validateFieldDefs, collectionNameSchema } from "./validation";
import { buildWhere, type WhereItem } from "./query";
import type { FieldDef } from "./field-types";

/**
 * Collection metadata changes rarely (only via define_collection or settings),
 * but is read on every MCP call, delivery request, and admin page. Each read is
 * an HTTPS round-trip to Neon, so definitions are cached cross-request and
 * revalidated by tag on write. Entries are NEVER cached — only schema metadata.
 */

const collectionsTag = (projectId: string) => `collections:${projectId}`;

/** unstable_cache serializes to JSON, so revive the timestamp columns. */
function revive(row: Collection): Collection {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/** List all collections in a project (cached; revalidated on define). */
export async function listCollections(projectId: string): Promise<Collection[]> {
  const cached = unstable_cache(
    () => db.select().from(collections).where(eq(collections.projectId, projectId)),
    ["collections-list", projectId],
    { tags: [collectionsTag(projectId)] },
  );
  return (await cached()).map(revive);
}

/** Fetch one collection by slug within a project (cached; revalidated on define). */
export async function getCollection(
  projectId: string,
  name: string,
): Promise<Collection | null> {
  const cached = unstable_cache(
    () =>
      db
        .select()
        .from(collections)
        .where(and(eq(collections.projectId, projectId), eq(collections.name, name)))
        .limit(1),
    ["collection", projectId, name],
    { tags: [collectionsTag(projectId)] },
  );
  const rows = await cached();
  return rows[0] ? revive(rows[0]) : null;
}

export interface DefineCollectionInput {
  name: string;
  displayName?: string;
  fields: FieldDef[];
  publicWrite?: boolean;
  webhookUrl?: string | null;
  /**
   * Row visibility for delivery reads: only rows matching ALL clauses are
   * publicly served (e.g. [{field:"approved",op:"eq",value:true}]). May
   * reference private fields. Admin/MCP reads are unaffected.
   */
  publicFilter?: WhereItem[] | null;
  /** Identity rule presets (Phase 4). owner rules need ownerField (a text field). */
  access?: {
    read?: "public" | "authenticated" | "owner";
    write?: "none" | "authenticated" | "owner";
    ownerField?: string;
  } | null;
  /** Declarative event actions (Phase 3). Email needs the Resend connector. */
  events?: {
    created?: EventAction[];
    updated?: EventAction[];
    deleted?: EventAction[];
  } | null;
  /** Required when redefinition drops or retypes fields (destructive). */
  confirm?: boolean;
}

const READ_RULES = ["public", "authenticated", "owner"] as const;
const WRITE_RULES = ["none", "authenticated", "owner"] as const;

async function validateAccessAndEvents(
  projectId: string,
  fields: FieldDef[],
  access: DefineCollectionInput["access"],
  events: DefineCollectionInput["events"],
): Promise<void> {
  if (access) {
    const read = access.read ?? "public";
    const write = access.write ?? "none";
    if (!READ_RULES.includes(read)) throw new ValidationError(`access.read must be one of ${READ_RULES.join("|")}`);
    if (!WRITE_RULES.includes(write)) throw new ValidationError(`access.write must be one of ${WRITE_RULES.join("|")}`);
    const needsOwner = read === "owner" || write === "owner" || write === "authenticated";
    if (needsOwner) {
      const f = fields.find((x) => x.name === access.ownerField);
      if (!access.ownerField || !f) {
        throw new ValidationError(
          'access: owner/authenticated rules need ownerField naming an existing field (add a text field, e.g. "owner")',
        );
      }
      if (f.type !== "text") {
        throw new ValidationError(`access.ownerField "${access.ownerField}" must be a text field (holds the user id)`);
      }
    }
  }
  if (events) {
    const all = [...(events.created ?? []), ...(events.updated ?? []), ...(events.deleted ?? [])];
    for (const a of all) {
      if (a.type === "webhook") {
        if (!/^https?:\/\//.test(a.url)) throw new ValidationError("events: webhook url must be http(s)");
      } else if (a.type === "email") {
        if (!a.to || !a.subject) throw new ValidationError("events: email actions need to + subject");
      } else {
        throw new ValidationError('events: action type must be "webhook" or "email"');
      }
    }
    if (all.some((a) => a.type === "email") && !(await getConnector(projectId, "resend"))) {
      throw new ValidationError(
        "events: email actions need the Resend connector — connect it in project settings first",
        "E_CONNECTOR_REQUIRED",
      );
    }
  }
}

export interface SchemaDiff {
  added: string[];
  removed: string[];
  retyped: { field: string; from: string; to: string }[];
  /** Entries whose stored data contains a removed/retyped key. */
  affectedEntries: number;
}

/** Structural diff between an existing definition and a proposed one. */
export function diffFields(
  oldFields: FieldDef[],
  newFields: FieldDef[],
): Omit<SchemaDiff, "affectedEntries"> {
  const oldByName = new Map(oldFields.map((f) => [f.name, f]));
  const newNames = new Set(newFields.map((f) => f.name));
  const added = newFields.filter((f) => !oldByName.has(f.name)).map((f) => f.name);
  const removed = oldFields.filter((f) => !newNames.has(f.name)).map((f) => f.name);
  const retyped = newFields
    .filter((f) => oldByName.has(f.name) && oldByName.get(f.name)!.type !== f.type)
    .map((f) => ({ field: f.name, from: oldByName.get(f.name)!.type, to: f.type }));
  return { added, removed, retyped };
}

/** Count entries that carry any of the given data keys. */
async function countEntriesWithKeys(collectionId: string, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const keyList = sql.join(keys.map((k) => sql`${k}`), sql`, `);
  const rows = await db
    .select({ n: count() })
    .from(entries)
    .where(
      and(eq(entries.collectionId, collectionId), sql`${entries.data} ?| ARRAY[${keyList}]::text[]`),
    );
  return rows[0]?.n ?? 0;
}

/**
 * `unique` fields are backed by partial unique indexes on entries, so
 * concurrent writers can't race past validation. The first 8 uuid hex chars
 * keep names inside Postgres's 63-char identifier cap (collision across
 * collections would need matching uuid prefixes AND field names — accepted).
 */
function uniqueIndexName(collectionId: string, field: string): string {
  return `entries_uq_${collectionId.replaceAll("-", "").slice(0, 8)}_${field}`.slice(0, 63);
}

async function syncUniqueIndexes(
  collectionId: string,
  oldFields: FieldDef[],
  newFields: FieldDef[],
): Promise<void> {
  const oldUnique = new Set(oldFields.filter((f) => f.unique).map((f) => f.name));
  const newUnique = new Set(newFields.filter((f) => f.unique).map((f) => f.name));

  for (const name of oldUnique) {
    if (!newUnique.has(name)) {
      await db.execute(sql.raw(`DROP INDEX IF EXISTS "${uniqueIndexName(collectionId, name)}"`));
    }
  }
  for (const name of newUnique) {
    if (oldUnique.has(name)) continue;
    try {
      // Field names are meta-validated snake_case and the id comes from the DB,
      // so inlining them into DDL is safe (DDL can't take bind parameters).
      await db.execute(
        sql.raw(
          `CREATE UNIQUE INDEX IF NOT EXISTS "${uniqueIndexName(collectionId, name)}" ` +
            `ON entries ((data->>'${name}')) WHERE collection_id = '${collectionId}'`,
        ),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as { code?: string }).code === "23505" || msg.includes("could not create unique index")) {
        throw new ValidationError(
          `cannot enable unique on "${name}": existing entries already contain duplicate values — deduplicate them first`,
        );
      }
      throw e;
    }
  }
}

export type DefineResult =
  | { applied: true; collection: Collection; diff?: SchemaDiff }
  | { applied: false; requiresConfirmation: true; diff: SchemaDiff; hint: string };

/**
 * Create or update a collection definition. Field defs are meta-validated
 * first; relation targets must exist. Destructive redefinitions (dropped or
 * retyped fields) return a plan and require confirm — Terraform-style, so an
 * agent can never silently orphan stored data.
 */
export async function defineCollection(
  projectId: string,
  input: DefineCollectionInput,
): Promise<DefineResult> {
  const name = collectionNameSchema.parse(input.name);
  const fields = validateFieldDefs(input.fields);

  // publicFilter clauses must be valid against these fields (throws with hint).
  if (input.publicFilter?.length) buildWhere(fields, input.publicFilter);
  await validateAccessAndEvents(projectId, fields, input.access, input.events);

  // Relation targets must resolve to a real collection in this project.
  const existing = await listCollections(projectId);
  const known = new Set(existing.map((c) => c.name).concat(name));
  for (const f of fields) {
    if (f.type === "relation" && !known.has(f.targetCollection)) {
      throw new Error(
        `relation field "${f.name}" targets unknown collection "${f.targetCollection}"`,
      );
    }
  }

  // Destructive-change gate for existing collections.
  const current = existing.find((c) => c.name === name);
  let diff: SchemaDiff | undefined;
  if (current) {
    const structural = diffFields(current.fields, fields);
    const dangerousKeys = [
      ...structural.removed,
      ...structural.retyped.map((r) => r.field),
    ];
    const affectedEntries = await countEntriesWithKeys(current.id, dangerousKeys);
    diff = { ...structural, affectedEntries };
    if (dangerousKeys.length > 0 && !input.confirm) {
      return {
        applied: false,
        requiresConfirmation: true,
        diff,
        hint: "destructive change — re-run with confirm: true to apply",
      };
    }
  }

  // Sync indexes BEFORE persisting the definition: if enabling unique fails on
  // existing duplicates, the stored schema must not claim a constraint the DB
  // doesn't enforce. (New collections sync after insert — they have no rows,
  // so index creation cannot fail.)
  if (current) await syncUniqueIndexes(current.id, current.fields, fields);

  const values = {
    projectId,
    name,
    displayName: input.displayName ?? name,
    fields,
    publicWrite: input.publicWrite ?? false,
    webhookUrl: input.webhookUrl ?? null,
    publicFilter: input.publicFilter ?? null,
    access: input.access ?? null,
    events: input.events ?? null,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(collections)
    .values(values)
    .onConflictDoUpdate({
      target: [collections.projectId, collections.name],
      set: {
        displayName: values.displayName,
        fields: values.fields,
        publicWrite: values.publicWrite,
        webhookUrl: values.webhookUrl,
        publicFilter: values.publicFilter,
        access: values.access,
        events: values.events,
        updatedAt: values.updatedAt,
      },
    })
    .returning();

  if (!current) await syncUniqueIndexes(row.id, [], fields);

  revalidateTag(collectionsTag(projectId));
  return { applied: true, collection: row, diff };
}

export interface DeletePlan {
  entryCount: number;
  /** Relation fields in OTHER collections that target this one. */
  inboundRelations: { collection: string; field: string }[];
}

/** What deleting a collection would destroy or break. */
export async function planDeleteCollection(
  projectId: string,
  name: string,
): Promise<DeletePlan | null> {
  const target = await getCollection(projectId, name);
  if (!target) return null;

  const [countRows, all] = await Promise.all([
    db
      .select({ n: count() })
      .from(entries)
      .where(eq(entries.collectionId, target.id)),
    listCollections(projectId),
  ]);

  const inboundRelations: DeletePlan["inboundRelations"] = [];
  for (const c of all) {
    if (c.name === name) continue;
    for (const f of c.fields) {
      if (f.type === "relation" && f.targetCollection === name) {
        inboundRelations.push({ collection: c.name, field: f.name });
      }
    }
  }
  return { entryCount: countRows[0]?.n ?? 0, inboundRelations };
}

/** Delete a collection and (via cascade) its entries. Caller enforces the plan. */
export async function deleteCollection(projectId: string, name: string): Promise<void> {
  const target = await getCollection(projectId, name);
  await db
    .delete(collections)
    .where(and(eq(collections.projectId, projectId), eq(collections.name, name)));
  // Partial unique indexes on entries outlive the cascade — drop them explicitly.
  if (target) await syncUniqueIndexes(target.id, target.fields, []);
  revalidateTag(collectionsTag(projectId));
}

/** Update collection settings (webhook, display name) outside define_collection. */
export async function updateCollectionSettings(
  projectId: string,
  name: string,
  patch: Partial<Pick<Collection, "displayName" | "publicWrite" | "webhookUrl">>,
): Promise<void> {
  await db
    .update(collections)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(collections.projectId, projectId), eq(collections.name, name)));
  revalidateTag(collectionsTag(projectId));
}
