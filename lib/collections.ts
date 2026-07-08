import { and, count, eq, sql } from "drizzle-orm";
import { unstable_cache, revalidateTag } from "next/cache";
import { db } from "@/db";
import { collections, entries, entriesTrash, type Collection, type EventAction } from "@/db/schema";
import { getConnector } from "./connectors";
import { ValidationError } from "./validation";
import { validateFieldDefs, collectionNameSchema } from "./validation";
import { buildWhere, type WhereItem } from "./query";
import { fieldMin, fieldMax, fieldPattern, fieldInteger, type FieldDef } from "./field-types";
import { publicSearchableFields, searchVectorText } from "./search";

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
  /**
   * Declared field renames: data is backfilled (old key moved to the new key),
   * so a rename never strands entries the way drop+add would. Types must match.
   */
  renames?: { from: string; to: string }[];
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
      // Conditional clauses get the same define-time validation as query where.
      if (a.when?.length) buildWhere(fields, a.when);
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
  /** Declared renames — non-destructive, data is backfilled. */
  renamed: { from: string; to: string }[];
  /** Entries whose stored data contains a removed/retyped key. */
  affectedEntries: number;
}

/** Structural diff between an existing definition and a proposed one. */
export function diffFields(
  oldFields: FieldDef[],
  newFields: FieldDef[],
  renames: { from: string; to: string }[] = [],
): Omit<SchemaDiff, "affectedEntries"> {
  const renameFroms = new Set(renames.map((r) => r.from));
  const renameTos = new Set(renames.map((r) => r.to));
  const oldByName = new Map(oldFields.map((f) => [f.name, f]));
  const newNames = new Set(newFields.map((f) => f.name));
  const added = newFields
    .filter((f) => !oldByName.has(f.name) && !renameTos.has(f.name))
    .map((f) => f.name);
  const removed = oldFields
    .filter((f) => !newNames.has(f.name) && !renameFroms.has(f.name))
    .map((f) => f.name);
  const retyped = newFields
    .filter((f) => oldByName.has(f.name) && oldByName.get(f.name)!.type !== f.type)
    .map((f) => ({ field: f.name, from: oldByName.get(f.name)!.type, to: f.type }));
  return { added, removed, retyped, renamed: renames };
}

/** A rename must move an existing field to a same-typed new field, cleanly. */
function validateRenames(
  current: Collection | undefined,
  newFields: FieldDef[],
  renames: { from: string; to: string }[],
): void {
  if (renames.length === 0) return;
  if (!current) {
    throw new ValidationError("renames: nothing to rename — this collection doesn't exist yet");
  }
  const seen = new Set<string>();
  for (const r of renames) {
    if (seen.has(r.from) || seen.has(r.to)) {
      throw new ValidationError(`renames: "${r.from}" → "${r.to}" overlaps another rename`);
    }
    seen.add(r.from).add(r.to);

    const oldField = current.fields.find((f) => f.name === r.from);
    if (!oldField) {
      throw new ValidationError(
        `renames: "${r.from}" is not a field of "${current.name}" — current fields: ${current.fields.map((f) => f.name).join(", ")}`,
      );
    }
    if (newFields.some((f) => f.name === r.from)) {
      throw new ValidationError(
        `renames: "${r.from}" still exists in the new definition — remove it (its data moves to "${r.to}")`,
      );
    }
    const newField = newFields.find((f) => f.name === r.to);
    if (!newField) {
      throw new ValidationError(`renames: "${r.to}" must be a field in the new definition`);
    }
    if (newField.type !== oldField.type) {
      throw new ValidationError(
        `renames: "${r.from}" (${oldField.type}) cannot become "${r.to}" (${newField.type}) — a rename cannot retype`,
      );
    }
    if (newField.unique && !oldField.unique) {
      throw new ValidationError(
        `renames: cannot add unique to "${r.to}" in the same call as the rename — rename first, then enable unique`,
      );
    }
  }
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

function searchIndexName(collectionId: string): string {
  return `entries_fts_${collectionId.replaceAll("-", "").slice(0, 8)}`;
}

/**
 * GIN expression index over the PUBLIC-searchable subset — so delivery ?q= is
 * always planner-matched (both the index and the query come from the identical
 * searchVectorText). MCP search_entries over the full set may scan when the
 * sets differ. Rebuilt only when the public subset changes (a searchable OR a
 * publicRead toggle). Dropped on collection delete so a partial index can't
 * outlive its collection (the unique-index gotcha).
 */
async function syncSearchIndex(
  collectionId: string,
  oldFields: FieldDef[],
  newFields: FieldDef[],
): Promise<void> {
  const key = (fs: FieldDef[]) =>
    publicSearchableFields(fs)
      .map((f) => `${f.name}:${f.type}`)
      .sort()
      .join(",");
  if (key(oldFields) === key(newFields)) return; // subset unchanged

  const name = searchIndexName(collectionId);
  await db.execute(sql.raw(`DROP INDEX IF EXISTS "${name}"`));
  const subset = publicSearchableFields(newFields);
  if (subset.length > 0) {
    await db.execute(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS "${name}" ON entries USING GIN ((${searchVectorText(subset)})) ` +
          `WHERE collection_id = '${collectionId}'`,
      ),
    );
  }
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
    // A date field newly made unique must canonicalize any values written
    // before A5 (which stores UTC ISO), so text-index equality means instant
    // equality — otherwise the same moment in two offsets wouldn't collide.
    // Values that don't parse are left as-is (indexed as raw text).
    if (newFields.find((f) => f.name === name)?.type === "date") {
      try {
        await db.execute(sql`
          UPDATE entries
          SET data = jsonb_set(
            data, ARRAY[${name}]::text[],
            to_jsonb(to_char((data->>${name})::timestamptz AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
          WHERE collection_id = ${collectionId}
            AND ${entries.data} ? ${name}
            AND data->>${name} <> to_char((data->>${name})::timestamptz AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
      } catch {
        // Legacy non-parseable date values: skip normalization, index as text.
      }
    }
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

export interface ConstraintWarning {
  field: string;
  constraint: "min" | "max" | "pattern" | "enum" | "integer";
  /** Absent when scanFailed — the count could not be computed. */
  existingViolations?: number;
  /** Pattern scans are capped — how many rows were actually checked. */
  scannedRows?: number;
  /** The count could not be computed (e.g. legacy data of the wrong type). */
  scanFailed?: true;
  hint: string;
}

export type DefineResult =
  | { applied: true; collection: Collection; diff?: SchemaDiff; constraintWarnings?: ConstraintWarning[] }
  | { applied: false; requiresConfirmation: true; diff: SchemaDiff; hint: string };

const TIGHTEN_HINT =
  "existing rows keep their values and stay readable; new writes must satisfy the constraint — patch them or leave them";
/** Pattern checks can't run in SQL (JS regex semantics) — cap the row scan. */
const PATTERN_SCAN_CAP = 5000;

/** Compare two same-type bounds; dates compare as instants. */
function boundExceeds(a: number | string, b: number | string, dateField: boolean): boolean {
  if (dateField) return Date.parse(String(a)) > Date.parse(String(b));
  return (a as number) > (b as number);
}

/**
 * Count existing entries that would fail a newly-TIGHTENED constraint.
 * Warn-only: nothing is mutated; enforcement stays write-time. Runs before
 * the rename backfill, so it queries data under the OLD key name.
 */
async function scanConstraintTightening(
  collectionId: string,
  oldFields: FieldDef[],
  newFields: FieldDef[],
  renames: { from: string; to: string }[],
): Promise<ConstraintWarning[]> {
  const renamedFrom = new Map(renames.map((r) => [r.to, r.from]));
  const warnings: ConstraintWarning[] = [];

  const countWhere = async (key: string, cond: ReturnType<typeof sql>): Promise<number> => {
    const rows = await db
      .select({ n: count() })
      .from(entries)
      .where(and(eq(entries.collectionId, collectionId), sql`${entries.data} ? ${key}`, cond));
    return rows[0]?.n ?? 0;
  };

  for (const f of newFields) {
    const key = renamedFrom.get(f.name) ?? f.name;
    const old = oldFields.find((o) => o.name === key);
    if (!old || old.type !== f.type) continue; // new/retyped fields aren't "tightening"
    const isDate = f.type === "date";
    const acc = sql`${entries.data}->>${key}`;

    // Each scan runs a ::numeric / ::timestamptz cast that can throw on legacy
    // rows of the wrong shape (data from before a confirmed retype). A scan
    // failure must NEVER abort defineCollection — it already synced indexes and
    // is about to persist — so degrade to a scanFailed warning instead.
    const scan = async (
      constraint: ConstraintWarning["constraint"],
      run: () => Promise<{ n: number; scannedRows?: number }>,
    ) => {
      try {
        const { n, scannedRows } = await run();
        if (n > 0) {
          warnings.push({
            field: f.name,
            constraint,
            existingViolations: n,
            ...(scannedRows !== undefined ? { scannedRows } : {}),
            hint: TIGHTEN_HINT,
          });
        }
      } catch {
        warnings.push({
          field: f.name,
          constraint,
          scanFailed: true,
          hint: "could not verify existing rows against the tightened constraint; it still applies to new writes",
        });
      }
    };

    const fMin = fieldMin(f), oMin = fieldMin(old);
    const fMax = fieldMax(f), oMax = fieldMax(old);

    if (fMin !== undefined && (oMin === undefined || boundExceeds(fMin, oMin, isDate))) {
      const cond =
        f.type === "number"
          ? sql`(${acc})::numeric < ${fMin}`
          : isDate
            ? sql`(${acc})::timestamptz < ${String(fMin)}::timestamptz`
            : sql`length(${acc}) < ${fMin}`;
      await scan("min", async () => ({ n: await countWhere(key, cond) }));
    }
    if (fMax !== undefined && (oMax === undefined || boundExceeds(oMax, fMax, isDate))) {
      const cond =
        f.type === "number"
          ? sql`(${acc})::numeric > ${fMax}`
          : isDate
            ? sql`(${acc})::timestamptz > ${String(fMax)}::timestamptz`
            : sql`length(${acc}) > ${fMax}`;
      await scan("max", async () => ({ n: await countWhere(key, cond) }));
    }
    if (f.type === "number" && fieldInteger(f) && !fieldInteger(old)) {
      await scan("integer", async () => ({ n: await countWhere(key, sql`(${acc})::numeric % 1 <> 0`) }));
    }
    if (f.type === "enum" && old.type === "enum") {
      const removed = (old.options ?? []).filter((o) => !(f.options ?? []).includes(o));
      if (removed.length > 0) {
        const list = sql.join(removed.map((o) => sql`${o}`), sql`, `);
        await scan("enum", async () => ({ n: await countWhere(key, sql`${acc} IN (${list})`) }));
      }
    }
    const fPattern = fieldPattern(f);
    if (f.type === "text" && fPattern !== undefined && fPattern !== fieldPattern(old)) {
      const re = new RegExp(fPattern);
      const cap = fMax as number; // pattern requires a numeric max (meta-validated)
      await scan("pattern", async () => {
        // Values past max never reach the regex — same guard as the write path,
        // so a hostile pattern can't be handed unbounded legacy input. Over-max
        // rows are write-invalid anyway and counted by the max scan above.
        const rows = await db
          .select({ v: sql<string>`${entries.data}->>${key}` })
          .from(entries)
          .where(
            and(
              eq(entries.collectionId, collectionId),
              sql`${entries.data} ? ${key}`,
              sql`length(${acc}) <= ${cap}`,
            ),
          )
          .limit(PATTERN_SCAN_CAP);
        return { n: rows.filter((r) => !re.test(r.v)).length, scannedRows: rows.length };
      });
    }
  }
  return warnings;
}

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
  const renames = input.renames ?? [];
  validateRenames(current, fields, renames);
  let diff: SchemaDiff | undefined;
  if (current) {
    const structural = diffFields(current.fields, fields, renames);
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
  if (current) {
    await syncUniqueIndexes(current.id, current.fields, fields);
    await syncSearchIndex(current.id, current.fields, fields);
  }

  // Tightened validator-level constraints apply to NEW writes immediately;
  // existing rows keep their values. Count what now violates, warn-only.
  const constraintWarnings = current
    ? await scanConstraintTightening(current.id, current.fields, fields, renames)
    : [];

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

  if (!current) {
    await syncUniqueIndexes(row.id, [], fields);
    await syncSearchIndex(row.id, [], fields);
  }

  // Backfill each rename: move the old key's value to the new key across every
  // entry that carries it — in the live table AND in trash, so a trashed row
  // restored after a rename lands under the new key.
  //
  // KNOWN LIMITATION (rare, recoverable): a restore that commits in the narrow
  // window between the entries and entries_trash UPDATEs can move a row into
  // `entries` still under the old key. A true fix needs advisory locks held
  // across these UPDATEs and every delete/restore CTE — impossible on the
  // neon-http driver (xact locks release at each statement boundary) without
  // moving all of it onto interactive transactions. Not worth that for a race
  // that needs a rename concurrent with a same-collection restore and is fixed
  // by re-saving the row. Do schema renames when the project is quiescent.
  for (const r of renames) {
    await db.execute(
      sql`UPDATE entries
          SET data = (data - ${r.from}::text) || jsonb_build_object(${r.to}::text, data->${r.from}::text)
          WHERE collection_id = ${row.id} AND data ? ${r.from}::text`,
    );
    await db.execute(
      sql`UPDATE entries_trash
          SET data = (data - ${r.from}::text) || jsonb_build_object(${r.to}::text, data->${r.from}::text)
          WHERE collection_id = ${row.id} AND data ? ${r.from}::text`,
    );
  }

  revalidateTag(collectionsTag(projectId));
  return {
    applied: true,
    collection: row,
    diff,
    ...(constraintWarnings.length > 0 ? { constraintWarnings } : {}),
  };
}

export interface DeletePlan {
  entryCount: number;
  /** Trashed entries in this collection that a cascade would also destroy. */
  trashedEntries: number;
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

  const [countRows, trashRows, all] = await Promise.all([
    db.select({ n: count() }).from(entries).where(eq(entries.collectionId, target.id)),
    db.select({ n: count() }).from(entriesTrash).where(eq(entriesTrash.collectionId, target.id)),
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
  return {
    entryCount: countRows[0]?.n ?? 0,
    trashedEntries: trashRows[0]?.n ?? 0,
    inboundRelations,
  };
}

/** Delete a collection and (via cascade) its entries. Caller enforces the plan. */
export async function deleteCollection(projectId: string, name: string): Promise<void> {
  const target = await getCollection(projectId, name);
  await db
    .delete(collections)
    .where(and(eq(collections.projectId, projectId), eq(collections.name, name)));
  // Partial indexes on entries outlive the cascade — drop them explicitly.
  if (target) {
    await syncUniqueIndexes(target.id, target.fields, []);
    await syncSearchIndex(target.id, target.fields, []);
  }
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
