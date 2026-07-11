import { and, asc, eq, sql } from "drizzle-orm";
import { tenantDb } from "./data-plane";
import { entryChanges, type ChangeKind, type ChangeVis, type Collection, type EntryChange } from "@/db/schema";
import { matchesClauses, type WhereItem } from "./query";
import { snapshotReadable, type ReadSpec } from "./access-rules";
import type { EndUser } from "./user-auth";
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
    await (await tenantDb(input.projectId)).insert(entryChanges).values(rowValues(input));
    maybePrune(input.projectId);
  } catch (e) {
    console.error("recordChange failed", e);
  }
}

/** Record MANY changes in one insert (bulk create, transact). Swallowed. */
export async function recordChanges(inputs: ChangeInput[]): Promise<void> {
  if (inputs.length === 0) return;
  try {
    await (await tenantDb(inputs[0].projectId)).insert(entryChanges).values(inputs.map(rowValues));
    maybePrune(inputs[0].projectId);
  } catch (e) {
    console.error("recordChanges failed", e);
  }
}

/** Like recordChanges but THROWS on failure — for collection-delete tombstones
 * (H3), where a lost tombstone (a client keeps ghost entries forever) is worse
 * than aborting the delete; a spurious tombstone from an aborted delete is
 * harmless (the entry still exists, the client just re-fetches). */
export async function recordChangesStrict(inputs: ChangeInput[]): Promise<void> {
  if (inputs.length === 0) return;
  await (await tenantDb(inputs[0].projectId)).insert(entryChanges).values(inputs.map(rowValues));
}

/** A change projected for the delivery surface. Tombstones carry no data. */
export interface DeliveryChange {
  cursor: string;
  collection: string;
  id: string;
  kind: ChangeKind;
  at: string;
  changedFields?: string[];
  data?: Record<string, unknown>;
}

const pick = (data: Record<string, unknown>, fields: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in data) out[f] = data[f];
  return out;
};

/** Does a snapshot pass BOTH write-time (vis) and current visibility for `user`?
 *  fieldsOut is the served field set (vis ∩ current publicRead); empty ⇒ no. */
function passesBoth(
  snapshot: Record<string, unknown>,
  visPf: boolean,
  visReadSpec: ReadSpec,
  current: Collection,
  fieldsOut: string[],
  user: EndUser | null,
): boolean {
  if (fieldsOut.length === 0) return false;
  // then: write-time publicFilter + write-time identity gate
  if (!visPf || !snapshotReadable(visReadSpec, snapshot, user)) return false;
  // now: current publicFilter + current identity gate
  const pf = (current.publicFilter as WhereItem[] | null) ?? [];
  if (pf.length > 0 && !matchesClauses(current.fields, pf, snapshot)) return false;
  const nowSpec: ReadSpec = {
    read: current.access?.read,
    ownerField: current.access?.ownerField,
    org: current.access?.org,
  };
  return snapshotReadable(nowSpec, snapshot, user);
}

/**
 * Gate one raw feed row for the delivery surface, encoding the cursor with
 * `seal`. Returns a projected change, a tombstone, or null (dropped — the cursor
 * still advances past it). The privacy core (H2): a row is served ONLY if it
 * passed both its write-time visibility AND the collection's CURRENT visibility
 * (broadening never exposes history; narrowing hides immediately), and only its
 * publicRead-both-then-and-now fields are projected. A visible→hidden update
 * becomes a `deleted` tombstone; a delete of a never-visible row is suppressed;
 * an orphaned collection serves only tombstones (existence, no data).
 */
export function projectChangeForDelivery(
  row: EntryChange,
  current: Collection | null,
  user: EndUser | null,
  seal: (seq: number) => string,
): DeliveryChange | null {
  const base = { cursor: seal(Number(row.seq)), collection: row.collectionName, id: row.entryId };
  const at = (row.createdAt as Date).toISOString();
  const visSpec: ReadSpec = { read: row.vis.read, ownerField: row.vis.ownerField, org: row.vis.org };

  // Orphaned collection (deleted since): drop created/updated; serve a delete
  // tombstone only if the pre-delete snapshot was visible at write time.
  if (!current) {
    if (row.kind !== "deleted") return null;
    // No current defs — gate on write-time vis alone.
    const fieldsThen = row.vis.fields;
    if (fieldsThen.length === 0 || !row.vis.pf || !snapshotReadable(visSpec, row.data, user)) return null;
    return { ...base, kind: "deleted", at };
  }

  const currentPublic = current.fields.filter((f) => f.publicRead).map((f) => f.name);
  const fieldsOut = row.vis.fields.filter((f) => currentPublic.includes(f));

  if (row.kind === "deleted") {
    return passesBoth(row.data, row.vis.pf, visSpec, current, fieldsOut, user)
      ? { ...base, kind: "deleted", at }
      : null; // never-visible delete → suppress (mirror 404-not-403)
  }

  // created / updated
  const visibleNow = passesBoth(row.data, row.vis.pf, visSpec, current, fieldsOut, user);
  if (visibleNow) {
    const data = pick(row.data, fieldsOut);
    const changedFields = row.changedFields?.filter((f) => fieldsOut.includes(f));
    // Timing-leak drop (openMinor #5): an update that changed only PRIVATE fields
    // must not broadcast timing — BUT only when the row was ALREADY visible (a
    // genuine visible→visible no-op). A hidden→visible transition (e.g. a private
    // `published` flip, title unchanged) also has an unchanged projection, and it
    // MUST be emitted — its original `created` was suppressed, so this is the only
    // event that tells a subscriber the row now exists.
    if (
      row.kind === "updated" &&
      row.prevData &&
      (changedFields?.length ?? 0) === 0 &&
      JSON.stringify(data) === JSON.stringify(pick(row.prevData, fieldsOut)) &&
      passesBoth(row.prevData, row.vis.prevPf ?? false, visSpec, current, fieldsOut, user)
    ) {
      return null;
    }
    return { ...base, kind: row.kind, at, changedFields, data };
  }

  // Update that left visibility (was visible, now hidden) ⇒ tombstone.
  if (row.kind === "updated" && row.prevData && row.vis.prevPf) {
    const prevVisible = passesBoth(row.prevData, row.vis.prevPf, visSpec, current, fieldsOut, user);
    if (prevVisible) return { ...base, kind: "deleted", at };
  }
  return null;
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

  const rows = await (await tenantDb(projectId))
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
  const [row] = await (await tenantDb(projectId))
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
      await (await tenantDb(projectId)).execute(sql`
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
