import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { entryChanges, type ChangeKind, type ChangeVis, type Collection, type EntryChange } from "@/db/schema";
import { matchesClauses, type WhereItem } from "./query";
import { defer } from "./defer";
import { ValidationError } from "./validation";

/**
 * The append-only change feed (H). Every entry mutation records one row INLINE
 * (post-write, error-swallowed) so a sync cursor never loses a row to a crash.
 * Reads gate on the INTERSECTION of write-time visibility (captured here in
 * `vis`) and the collection's CURRENT rules, so broadening visibility never
 * retroactively exposes history. MCP get_changes is full-trust (no projection);
 * the delivery endpoint (H2) applies the intersection gate.
 */

const RETENTION_DAYS = 30;
const HOLD_BACK_SECONDS = 2; // keeps the bigserial cursor monotone under late commits

/** Write-time visibility of a snapshot — the "then" half of the read gate. */
export function computeVis(
  collection: Collection,
  data: Record<string, unknown>,
  prevData?: Record<string, unknown>,
): ChangeVis {
  const pfClauses = (collection.publicFilter as WhereItem[] | null) ?? [];
  const matchPf = (d: Record<string, unknown>) =>
    pfClauses.length === 0 ? true : matchesClauses(collection.fields, pfClauses, d);
  const vis: ChangeVis = {
    fields: collection.fields.filter((f) => f.publicRead).map((f) => f.name),
    pf: matchPf(data),
    read: collection.access?.read ?? "public",
  };
  if (collection.access?.ownerField) vis.ownerField = collection.access.ownerField;
  if (collection.access?.org) vis.org = collection.access.org;
  if (prevData) vis.prevPf = matchPf(prevData);
  return vis;
}

export interface ChangeInput {
  projectId: string;
  collection: Collection;
  kind: ChangeKind;
  entryId: string;
  /** Snapshot at event time: post-change for create/update, pre-delete for delete. */
  data: Record<string, unknown>;
  /** Pre-image (plain + CAS updates); null for create/delete. */
  prevData?: Record<string, unknown>;
  changedFields?: string[];
}

function rowValues(c: ChangeInput) {
  return {
    projectId: c.projectId,
    collectionId: c.collection.id,
    collectionName: c.collection.name,
    entryId: c.entryId,
    kind: c.kind,
    data: c.data,
    prevData: c.prevData ?? null,
    changedFields: c.changedFields ?? null,
    vis: computeVis(c.collection, c.data, c.prevData),
  };
}

/** Record ONE change. Swallowed on failure (the feed is near-exact, not a
 * transactional outbox — clients periodically reconcile with a full list). */
export async function recordChange(input: ChangeInput): Promise<void> {
  try {
    await db.insert(entryChanges).values(rowValues(input));
    maybePrune(input.projectId);
  } catch (e) {
    console.error("recordChange failed", e);
  }
}

/** Record MANY changes in one insert (bulk create, collection-delete tombstones). */
export async function recordChanges(inputs: ChangeInput[]): Promise<void> {
  if (inputs.length === 0) return;
  try {
    await db.insert(entryChanges).values(inputs.map(rowValues));
    maybePrune(inputs[0].projectId);
  } catch (e) {
    console.error("recordChanges failed", e);
  }
}

export interface ListChangesOpts {
  since?: number;
  collectionId?: string;
  limit?: number;
}

/** A page of raw feed rows after `since`, oldest-first, with the 2s hold-back so
 * the cursor never skips a late-committing seq. limit+1 hasMore idiom. */
export async function listChanges(
  projectId: string,
  opts: ListChangesOpts = {},
): Promise<{ changes: EntryChange[]; hasMore: boolean; cursor: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conds = [
    eq(entryChanges.projectId, projectId),
    sql`${entryChanges.createdAt} <= now() - interval '${sql.raw(String(HOLD_BACK_SECONDS))} seconds'`,
  ];
  if (opts.since !== undefined) conds.push(sql`${entryChanges.seq} > ${opts.since}`);
  if (opts.collectionId) conds.push(eq(entryChanges.collectionId, opts.collectionId));

  const rows = await db
    .select()
    .from(entryChanges)
    .where(and(...conds))
    .orderBy(asc(entryChanges.seq))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const changes = rows.slice(0, limit);
  const cursor = changes.length > 0 ? Number(changes[changes.length - 1].seq) : (opts.since ?? 0);
  return { changes, hasMore, cursor };
}

/** The latest visible seq for a project (delivery bootstrap: omitted `since`). */
export async function latestSeq(projectId: string): Promise<number> {
  const [row] = await db
    .select({ seq: entryChanges.seq })
    .from(entryChanges)
    .where(
      and(
        eq(entryChanges.projectId, projectId),
        sql`${entryChanges.createdAt} <= now() - interval '${sql.raw(String(HOLD_BACK_SECONDS))} seconds'`,
      ),
    )
    .orderBy(sql`${entryChanges.seq} DESC`)
    .limit(1);
  return row ? Number(row.seq) : 0;
}

/** Opaque cursor: base64url({s: seq}). (H2 seals it against cross-tenant
 * inspection; MCP get_changes is full-trust so the plain form is fine here.) */
export function encodeChangeCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ s: seq }), "utf8").toString("base64url");
}

export function decodeChangeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed?.s === "number" && Number.isFinite(parsed.s)) return parsed.s;
  } catch {
    /* fall through to the hint */
  }
  throw new ValidationError(
    "invalid cursor — pass the cursor from a previous /v1/changes (or get_changes) response, or omit it to start from the beginning",
  );
}

/** Probabilistic on-write retention prune (~1%): a bounded DELETE of rows past
 * the window, deferred off the request. (Migrate to a G1 scheduled job later —
 * the runner now exists; this is the documented stopgap.) */
function maybePrune(projectId: string): void {
  if (Math.random() > 0.01) return;
  defer(async () => {
    try {
      await db.execute(sql`
        DELETE FROM ${entryChanges}
        WHERE id IN (
          SELECT id FROM ${entryChanges}
          WHERE project_id = ${projectId}
            AND created_at < now() - interval '${sql.raw(String(RETENTION_DAYS))} days'
          LIMIT 1000
        )`);
    } catch (e) {
      console.error("change-feed prune failed", e);
    }
  });
}
