import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  entries,
  entriesTrash,
  entryVersions,
  assets,
  collections,
  transactReceipts,
  type Collection,
  type Entry,
} from "@/db/schema";
import {
  buildEntrySchema,
  formatZodError,
  issuesFromZod,
  ValidationError,
  type RefCheck,
  type ConstraintIssue,
} from "./validation";
import {
  accessor,
  buildWhere,
  buildWhereParts,
  buildOrderBy,
  matchesClauses,
  WHERE_OPS,
  type WhereItem,
  type WhereOp,
  type OrderByClause,
  type RelatedContextMap,
} from "./query";
import { emitEntryEvent, runEventAction, type EntryEvent } from "./events";
import { callWriteHook, type HookEnvelope } from "./hooks";
import { evaluateComputed } from "./computed";
import { stampIdentity, stampedIdentityFields } from "./access-rules";
import { applyWorkflowOnCreate, checkTransition, matchTransition } from "./workflow";
import { recordChange, recordChanges, type ChangeInput } from "./changes";
import type { WorkflowActor } from "@/db/schema";
import { recordAudit } from "./audit";
import { defer } from "./defer";
import { withTransaction, type DbExecutor } from "./db-tx";
import { recordVersion } from "./versions";
import { getCollection } from "./collections";
import { orgClaimValue } from "./access-rules";
import type { EndUser } from "./user-auth";
import type { ErrorCode } from "./error-codes";
import type { AuditActor } from "@/db/schema";

const UNKNOWN_ACTOR: AuditActor = { type: "unknown" };
import type { FieldDef } from "./field-types";
import { z } from "zod";

/**
 * Entry CRUD with full validation. Every write goes through buildEntrySchema
 * (shape + type + enum + required) and then verifyRefs (relation/asset ids
 * actually exist). This is what "an AI can't corrupt stored data" means in
 * practice.
 *
 * Every Neon query is an HTTPS round-trip, so this module batches aggressively:
 * one query for all asset refs, one per target collection for relation refs,
 * one for all relation labels — never one query per field.
 */

export { ValidationError };

/**
 * Check that relation/asset ids referenced by an entry exist in this project.
 * `assumeExisting` ids skip the DB probe — used by transact for rows created
 * earlier in the same batch (guaranteed present by in-tx insert order).
 */
async function verifyRefs(
  projectId: string,
  data: Record<string, unknown>,
  refChecks: RefCheck[],
  assumeExisting?: Set<string>,
): Promise<void> {
  const assetIds: { field: string; id: string }[] = [];
  const relByTarget = new Map<string, { field: string; id: string }[]>();

  for (const ref of refChecks) {
    const value = data[ref.field];
    if (value == null) continue; // optional / not provided
    if (assumeExisting?.has(value as string)) continue; // same-batch create
    if (ref.kind === "asset") {
      assetIds.push({ field: ref.field, id: value as string });
    } else {
      const list = relByTarget.get(ref.targetCollection!) ?? [];
      list.push({ field: ref.field, id: value as string });
      relByTarget.set(ref.targetCollection!, list);
    }
  }
  if (assetIds.length === 0 && relByTarget.size === 0) return;

  const checks: Promise<void>[] = [];

  if (assetIds.length > 0) {
    checks.push(
      db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            inArray(assets.id, assetIds.map((a) => a.id)),
            eq(assets.projectId, projectId),
          ),
        )
        .then((found) => {
          const ok = new Set(found.map((f) => f.id));
          for (const a of assetIds) {
            if (!ok.has(a.id)) {
              throw new ValidationError(`${a.field}: asset ${a.id} not found`, "E_VALIDATION", [
                {
                  field: a.field,
                  constraint: "ref_missing",
                  hint: `asset ${a.id} not found — upload_asset first or fix the id`,
                },
              ]);
            }
          }
        }),
    );
  }

  for (const [targetName, refs] of relByTarget) {
    checks.push(
      db
        .select({ id: entries.id })
        .from(entries)
        .innerJoin(collections, eq(entries.collectionId, collections.id))
        .where(
          and(
            inArray(entries.id, refs.map((r) => r.id)),
            eq(collections.projectId, projectId),
            eq(collections.name, targetName),
          ),
        )
        .then((found) => {
          const ok = new Set(found.map((f) => f.id));
          for (const r of refs) {
            if (!ok.has(r.id)) {
              throw new ValidationError(`${r.field}: no entry ${r.id} in "${targetName}"`, "E_VALIDATION", [
                {
                  field: r.field,
                  constraint: "ref_missing",
                  hint: `no entry ${r.id} in "${targetName}" — query_entries that collection for a valid id`,
                },
              ]);
            }
          }
        }),
    );
  }

  await Promise.all(checks);
}

function validate(
  fields: FieldDef[],
  data: unknown,
  partial: boolean,
  mode: "input" | "storage" = "input",
): Record<string, unknown> {
  const { schema } = buildEntrySchema(fields, partial, mode);
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new ValidationError(formatZodError(e), "E_VALIDATION", issuesFromZod(e, fields));
    }
    throw e;
  }
}

/** Full searchable text of a DB error (message + constraint name if exposed). */
export function dbErrorText(e: unknown): string {
  const constraint = String((e as { constraint?: string }).constraint ?? "");
  return (e instanceof Error ? e.message : String(e)) + " " + constraint;
}

/** Map partial-unique-index violations (23505) to agent-repairable errors. */
export function rethrowUnique(e: unknown): never {
  const m = /entries_uq_[0-9a-f]{8}_([a-z][a-z0-9_]*)/.exec(dbErrorText(e));
  if (m) {
    throw new ValidationError(`${m[1]}: value already exists — this field is unique`, "E_VALIDATION", [
      {
        field: m[1],
        constraint: "unique",
        hint: "value already exists — this field is unique; query_entries to find the holder",
      },
    ]);
  }
  throw e;
}

/**
 * What a committed mutation should broadcast. The cores return this instead of
 * firing events directly, so a single op fires immediately while `transact`
 * collects them and fires the whole batch only after the transaction commits.
 * `emit: null` = no event (an idempotency replay wrote nothing).
 */
export interface EmitDescriptor {
  event: EntryEvent;
  entry: { id: string; data?: Record<string, unknown> };
  previous?: Record<string, unknown>;
  /** G4: set when this update crossed a workflow transition — the public fn
   * fires the matched transition's actions as an entry.transitioned event. */
  transition?: { field: string; from: string; to: string };
}

/** Map an AuditActor to a workflow actor, or undefined for an unknown surface
 * (which then may NOT drive a transition — fail-closed). */
function workflowActor(actor: AuditActor): WorkflowActor | undefined {
  return actor.type === "mcp" || actor.type === "admin" || actor.type === "delivery" ? actor.type : undefined;
}

/** Fire a matched transition's actions (deferred) as an entry.transitioned event. */
function fireTransition(collection: Collection, emit: EmitDescriptor): void {
  if (!emit.transition || !collection.workflow) return;
  const t = matchTransition(collection.workflow, emit.transition.from, emit.transition.to);
  if (!t?.actions?.length) return;
  const payload = {
    collection: collection.name,
    entry: emit.entry,
    ...(emit.previous ? { previous: { data: emit.previous } } : {}),
    transition: emit.transition,
  };
  defer(() =>
    Promise.allSettled(
      t.actions!.map((a) => runEventAction(collection, "entry.transitioned", a, emit.entry, payload)),
    ),
  );
}

/**
 * The write choke point for creates. Runs on any executor (`db` or a tx), does
 * the insert ONLY — the caller must have validated, verifyRefs'd, AND consulted
 * the before-create hook first. Both create paths do so before reaching here:
 * createEntry (single op) and transact's prep pass (batch). The hook is
 * deliberately NOT inside the core — it makes an external HTTP call, which must
 * never run inside transact's open interactive transaction.
 */
async function createEntryCore(
  dbc: DbExecutor,
  projectId: string,
  collection: Collection,
  clean: Record<string, unknown>,
  opts: { id?: string; idempotencyKey?: string } = {},
): Promise<{ entry: Entry; emit: EmitDescriptor | null }> {
  // Conflicts are handled explicitly (not onConflictDoNothing) so an
  // idempotency replay and a unique-field violation stay distinguishable.
  let row: Entry | undefined;
  try {
    [row] = await dbc
      .insert(entries)
      .values({
        ...(opts.id ? { id: opts.id } : {}),
        projectId,
        collectionId: collection.id,
        data: clean,
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .returning();
  } catch (e) {
    if (!/entries_idempotency_idx/.test(dbErrorText(e))) rethrowUnique(e);
  }
  if (row) {
    return { entry: row, emit: { event: "created", entry: { id: row.id, data: row.data } } };
  }
  // Conflict = this idempotency key already created an entry; return it, no event.
  const [existing] = await dbc
    .select()
    .from(entries)
    .where(
      and(eq(entries.collectionId, collection.id), eq(entries.idempotencyKey, opts.idempotencyKey!)),
    )
    .limit(1);
  return { entry: existing, emit: null };
}

/** Identity to re-stamp after a transform. Presence marks the DELIVERY path
 * (re-stamp with `user`, which may be null=anonymous); ABSENCE marks a
 * full-trust MCP/admin write (no re-stamp). */
export interface WriteIdentity {
  user: EndUser | null;
}

/**
 * I1a/I1b: consult the before-create hook and return the data to actually
 * write. Throws E_HOOK_REJECTED (tenant rejected) or E_HOOK_FAILED (unreachable/
 * malformed AND onError:'reject', the fail-closed default). A disabled hook, a
 * non-matching `when`, or onError:'allow' on an outage returns the data
 * unchanged. A transform's replacement is re-validated FULLY and ownership is
 * re-stamped from the verified identity — a hook can NEVER move ownership.
 */
async function runBeforeCreateHook(
  projectId: string,
  collection: Collection,
  data: Record<string, unknown>,
  identity?: WriteIdentity,
  /** transact passes its same-batch create ids so a transform's re-verifyRefs
   *  doesn't reject a $ref to a sibling row not yet in the DB. */
  assumeExisting?: Set<string>,
): Promise<Record<string, unknown>> {
  const hook = collection.hooks?.beforeCreate;
  if (!hook || hook.disabled) return data;
  if (hook.when?.length && !matchesClauses(collection.fields, hook.when, data)) return data;
  const outcome = await callWriteHook(projectId, collection, hook, {
    event: "entry.before_create",
    collection: collection.name,
    candidate: { data },
  });
  if (outcome.kind === "reject") {
    // The machine code is ALWAYS E_HOOK_REJECTED (stable for clients); the
    // hook's own message is the human reason. A hook cannot mint arbitrary codes.
    throw new ValidationError(outcome.error, "E_HOOK_REJECTED");
  }
  if (outcome.kind === "unavailable") {
    if ((hook.onError ?? "reject") === "reject") {
      throw new ValidationError(`before-write hook could not be consulted: ${outcome.reason}`, "E_HOOK_FAILED");
    }
    return data; // fail-open
  }
  if (outcome.kind === "replace") {
    // The transform's FULL output is re-validated exactly like client input,
    // the initial-state workflow rule re-applied, ownership re-stamped from the
    // verified identity, and refs re-checked — the hook has no more authority
    // than an honest client and cannot move ownership or dangle a relation.
    let out = validate(collection.fields, outcome.data, false);
    applyWorkflowOnCreate(collection, out);
    if (identity) out = stampIdentity(collection, identity.user, out);
    const { refChecks } = buildEntrySchema(collection.fields);
    await verifyRefs(projectId, out, refChecks, assumeExisting);
    return out;
  }
  return data;
}

export async function createEntry(
  projectId: string,
  collection: Collection,
  data: unknown,
  opts: { idempotencyKey?: string; actor?: AuditActor; identity?: WriteIdentity } = {},
): Promise<Entry> {
  const clean = validate(collection.fields, data, false);
  applyWorkflowOnCreate(collection, clean); // default/enforce the initial state
  const { refChecks } = buildEntrySchema(collection.fields);
  await verifyRefs(projectId, clean, refChecks);

  // I1a/I1b: consult the before-create hook AFTER cheap local validation, BEFORE
  // the write. A rejection or fail-closed outage stops the insert; a transform
  // returns the (re-validated, re-stamped) data to write instead.
  const finalData = await runBeforeCreateHook(projectId, collection, clean, opts.identity);

  // I3: stamp computed fields AFTER the candidate (+ any transform) is validated,
  // then re-validate in STORAGE mode so the derived output still obeys min/max
  // (unique surfaces at insert via the partial index). No-op without computed fields.
  const toWrite = collection.fields.some((f) => f.computed)
    ? validate(collection.fields, evaluateComputed(collection.fields, finalData), false, "storage")
    : finalData;

  const { entry, emit } = await createEntryCore(db, projectId, collection, toWrite, {
    idempotencyKey: opts.idempotencyKey,
  });
  if (emit) {
    // Inline change-feed write (H) BEFORE the deferred side-work — a sync cursor
    // must not lose the row to a crash. Idempotency replays (emit=null) record nothing.
    await recordChange({ projectId, collection, kind: "created", entryId: entry.id, data: entry.data });
    defer(() => emitEntryEvent(collection, emit.event, emit.entry, emit.previous));
    recordAudit({
      projectId,
      collectionName: collection.name,
      entryId: entry.id,
      action: "create",
      actor: opts.actor ?? UNKNOWN_ACTOR,
      changedFields: Object.keys(toWrite),
    });
  }
  return entry;
}

/**
 * The write choke point for updates. Fetches the pre-image on the SAME executor
 * (so a tx sees a tx-consistent row), applies the null-aware merge, writes, and
 * returns the row plus an emit descriptor carrying `previous`. Caller validates
 * + verifyRefs first. Throws E_NOT_FOUND when the row is absent.
 */
async function updateEntryCore(
  dbc: DbExecutor,
  collection: Collection,
  id: string,
  patch: Record<string, unknown>,
  actorType?: WorkflowActor,
): Promise<{ entry: Entry; emit: EmitDescriptor }> {
  const [current] = await dbc
    .select()
    .from(entries)
    .where(and(eq(entries.id, id), eq(entries.collectionId, collection.id)))
    .limit(1);
  if (!current) throw new ValidationError(`entry ${id} not found`, "E_NOT_FOUND");

  // G4: a workflow move is validated (actor + from→to) BEFORE the write and
  // guarded so a concurrent change since our read fails as E_CONFLICT.
  const guards: SQL[] = [];
  let transition: EmitDescriptor["transition"];
  const wf = collection.workflow;
  if (wf && wf.field in patch) {
    const from = current.data[wf.field];
    const to = patch[wf.field];
    // from === to is an idempotent no-op — checked FIRST, so it never trips the
    // transition validator. A source-only state (draft, or K4 orders 'pending')
    // is never any transition's TARGET, so a full-replace patch (I1b transform)
    // that echoes the unchanged field must NOT be treated as a move.
    if (to !== from) {
      if (!actorType) {
        throw new ValidationError(`workflow: "${wf.field}" can only be changed by a known actor (mcp/admin/delivery)`);
      }
      const check = checkTransition(collection, actorType, patch)!; // throws E_VALIDATION on a bad target/actor
      if (typeof from !== "string" || !check.allowedFroms.includes(from)) {
        throw new ValidationError(
          `workflow: "${wf.field}" cannot move ${JSON.stringify(from)} → "${check.to}" for actor "${actorType}" — allowed from: ${check.allowedFroms.join(", ")}`,
        );
      }
      guards.push(sql`${entries.data}->>${wf.field} = ${from}`);
      transition = { field: wf.field, from, to: check.to };
    }
  }

  // null = explicit unset (validate() already rejected null on required fields).
  const sets: Record<string, unknown> = {};
  const unsetKeys: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) unsetKeys.push(k);
    else sets[k] = v;
  }
  const merged = { ...current.data, ...sets };
  for (const k of unsetKeys) delete merged[k];
  let row: Entry | undefined;
  try {
    [row] = await dbc
      .update(entries)
      .set({ data: merged, updatedAt: new Date() })
      .where(and(eq(entries.id, id), ...guards))
      .returning();
  } catch (e) {
    rethrowUnique(e);
  }
  if (!row) {
    // With a transition guard, a 0-row means the field moved since our read (or
    // the row was deleted): a conflict to re-read and retry. Without a guard, a
    // 0-row means a concurrent delete → E_NOT_FOUND.
    if (transition) {
      throw new ValidationError(
        `workflow: "${transition.field}" changed since read — concurrent transition, re-read and retry`,
        "E_CONFLICT",
      );
    }
    throw new ValidationError(`entry ${id} not found`, "E_NOT_FOUND");
  }
  return {
    entry: row,
    emit: { event: "updated", entry: { id: row.id, data: row.data }, previous: current.data, transition },
  };
}

/** {...current, ...patch} with null = unset — the merged snapshot the hook sees. */
function mergePatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** A patch that, merged onto `current`, yields EXACTLY `full`: every full key,
 * plus null for any current key the transform dropped (so it is unset). */
function buildReplacePatch(
  current: Record<string, unknown>,
  full: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...full };
  for (const k of Object.keys(current)) if (!(k in full)) patch[k] = null;
  return patch;
}

/**
 * I1b: consult the before-UPDATE hook and return the patch to actually apply.
 * The hook sees the MERGED post-patch snapshot (candidate) + the current row.
 * A transform's FULL output is re-validated, then identity fields are RE-STRIPPED
 * to the CURRENT row's values — a transform can never move ownership on update —
 * and converted to a replace patch. Throws E_HOOK_REJECTED / E_HOOK_FAILED.
 */
async function runBeforeUpdateHook(
  projectId: string,
  collection: Collection,
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const hook = collection.hooks!.beforeUpdate!;
  const [current] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.id, id), eq(entries.collectionId, collection.id)))
    .limit(1);
  if (!current) throw new ValidationError(`entry ${id} not found`, "E_NOT_FOUND");
  const merged = mergePatch(current.data, patch);
  if (hook.when?.length && !matchesClauses(collection.fields, hook.when, merged)) return patch;
  const outcome = await callWriteHook(projectId, collection, hook, {
    event: "entry.before_update",
    collection: collection.name,
    candidate: { data: merged },
    current: { data: current.data },
  });
  if (outcome.kind === "reject") throw new ValidationError(outcome.error, "E_HOOK_REJECTED");
  if (outcome.kind === "unavailable") {
    if ((hook.onError ?? "reject") === "reject") {
      throw new ValidationError(`before-write hook could not be consulted: ${outcome.reason}`, "E_HOOK_FAILED");
    }
    return patch; // fail-open
  }
  if (outcome.kind === "replace") {
    // Server-derived fields are frozen w.r.t. a hook on update: identity
    // (ownership immutable) AND computed (I3 freezes computed on update). Strip
    // them from the transform output BEFORE validation — the candidate the hook
    // saw echoes their current values, which INPUT mode would reject — then
    // restore the CURRENT values so the hook can't move them.
    const frozen = [
      ...stampedIdentityFields(collection),
      ...collection.fields.filter((f) => f.computed).map((f) => f.name),
    ];
    const raw = { ...(outcome.data as Record<string, unknown>) };
    for (const f of frozen) delete raw[f];
    const full = validate(collection.fields, raw, false);
    for (const f of frozen) {
      if (f in current.data) full[f] = current.data[f];
    }
    const { refChecks } = buildEntrySchema(collection.fields);
    await verifyRefs(projectId, full, refChecks);
    return buildReplacePatch(current.data, full);
  }
  return patch;
}

export async function updateEntry(
  projectId: string,
  collection: Collection,
  id: string,
  data: unknown,
  actor: AuditActor = UNKNOWN_ACTOR,
): Promise<Entry> {
  let patch = validate(collection.fields, data, true);
  const { refChecks } = buildEntrySchema(collection.fields, true);
  await verifyRefs(projectId, patch, refChecks);

  // I1b: consult the before-update hook (validate gates; transform replaces the
  // patch with the re-validated, identity-re-stripped full entry).
  if (collection.hooks?.beforeUpdate && !collection.hooks.beforeUpdate.disabled) {
    patch = await runBeforeUpdateHook(projectId, collection, id, patch);
  }

  const { entry, emit } = await updateEntryCore(db, collection, id, patch, workflowActor(actor));
  await recordChange({
    projectId,
    collection,
    kind: "updated",
    entryId: entry.id,
    data: entry.data,
    prevData: emit.previous,
    changedFields: Object.keys(patch),
  });
  defer(() => emitEntryEvent(collection, emit.event, emit.entry, emit.previous));
  fireTransition(collection, emit);
  if (emit.previous) {
    recordVersion({
      projectId,
      collectionId: collection.id,
      entryId: entry.id,
      data: emit.previous,
      changedFields: Object.keys(patch),
      actor,
    });
  }
  recordAudit({
    projectId,
    collectionName: collection.name,
    entryId: entry.id,
    action: "update",
    actor,
    changedFields: Object.keys(patch),
  });
  return entry;
}

export interface HookTestResult {
  verdict: "proceed" | "replaced" | "rejected" | "unavailable";
  /** The (parsed) response the endpoint gave. */
  hookResponse: Record<string, unknown>;
  /** For a transform: what WOULD be written (before ownership re-stamp). */
  finalData?: Record<string, unknown>;
  validationOfFinalData?: { ok: boolean; error?: string };
}

/**
 * I2: consult a collection's hook for `data` WITHOUT writing anything — the
 * self-repair loop an agent runs before pointing production writes at an
 * endpoint. Side-effect-free on AgentX (no insert/update), but it DOES call the
 * tenant endpoint (logged as 'hook.test'). Ownership re-stamp is NOT applied —
 * this shows the endpoint's RAW verdict; the write path re-stamps regardless.
 */
export async function dryRunHook(
  projectId: string,
  collection: Collection,
  stage: "beforeCreate" | "beforeUpdate",
  data: unknown,
  current?: Record<string, unknown>,
): Promise<HookTestResult> {
  const hook = collection.hooks?.[stage];
  if (!hook) throw new ValidationError(`"${collection.name}" has no ${stage} hook configured — define one first`);

  let envelope: HookEnvelope;
  if (stage === "beforeCreate") {
    const clean = validate(collection.fields, data, false);
    applyWorkflowOnCreate(collection, clean);
    envelope = { event: "entry.before_create", collection: collection.name, candidate: { data: clean } };
  } else {
    if (!current) throw new ValidationError("beforeUpdate test needs entryId — the row the update targets");
    const patch = validate(collection.fields, data, true);
    envelope = {
      event: "entry.before_update",
      collection: collection.name,
      candidate: { data: mergePatch(current, patch) },
      current: { data: current },
    };
  }

  const outcome = await callWriteHook(projectId, collection, hook, envelope, "hook.test");
  if (outcome.kind === "reject") {
    return { verdict: "rejected", hookResponse: { ok: false, error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) } };
  }
  if (outcome.kind === "unavailable") {
    return { verdict: "unavailable", hookResponse: { error: outcome.reason } };
  }
  if (outcome.kind === "replace") {
    // Mirror the real write path so the dry-run's verdict matches it: on update,
    // identity + computed fields are frozen (stripped then restored), and the
    // merged candidate the hook echoed carries their current values — which INPUT
    // mode would reject. Validate the SAME shape the write path validates.
    let toValidate = outcome.data;
    if (stage === "beforeUpdate") {
      const frozen = [
        ...stampedIdentityFields(collection),
        ...collection.fields.filter((f) => f.computed).map((f) => f.name),
      ];
      const stripped = { ...(outcome.data as Record<string, unknown>) };
      for (const f of frozen) delete stripped[f];
      toValidate = stripped;
    }
    let validationOfFinalData: { ok: boolean; error?: string };
    try {
      validate(collection.fields, toValidate, false);
      validationOfFinalData = { ok: true };
    } catch (e) {
      validationOfFinalData = { ok: false, error: e instanceof ValidationError ? e.message : String(e) };
    }
    return { verdict: "replaced", hookResponse: { ok: true, data: outcome.data }, finalData: outcome.data, validationOfFinalData };
  }
  return { verdict: "proceed", hookResponse: { ok: true } };
}

export interface UpdateIfOpts {
  /** Conditions on the CURRENT row, re-checked atomically inside the UPDATE. */
  if?: WhereItem[];
  /** Ordinary validated patch (merged like update_entry). */
  data?: unknown;
  /** Atomic increment computed in SQL from the old value — never read-modify-write. */
  increment?: { field: string; by: number };
  actor?: AuditActor;
}

export type UpdateIfReason = "not_found" | "conflict" | "unset" | "bounds";

export type UpdateIfResult =
  | { ok: true; entry: Entry }
  | {
      ok: false;
      reason: UpdateIfReason;
      /** Human/agent message naming the offending guard(s), hedged to the latest read. */
      message?: string;
      /** Labels of the if-clauses that did not hold. */
      failedGuards?: string[];
      /** The row as of the diagnostic read (absent when not_found). */
      current?: Record<string, unknown>;
    };

/**
 * Explain a 0-row CAS UPDATE with ONE diagnostic SELECT. Postgres re-evaluates
 * every guard from the failed WHERE — the same compiled fragments buildWhere
 * used — so NULL/missing-key semantics match the UPDATE exactly. A JS re-check
 * (matchesClauses) is deliberately NOT used: its `String(undefined ?? "")`
 * coercion diverges from SQL's `data->>'f'` = NULL and would misdiagnose.
 * On the neon-http path the row may have changed between UPDATE and this SELECT,
 * so messages are hedged; inside a transaction (B4) the read is race-free.
 */
async function diagnoseCasFailure(
  dbc: DbExecutor,
  collection: Collection,
  id: string,
  opts: UpdateIfOpts,
  incField: FieldDef | undefined,
  raceFree: boolean,
): Promise<Extract<UpdateIfResult, { ok: false }>> {
  // Inside a transaction the diagnostic SELECT sees the exact row version the
  // UPDATE saw, so the verdict is authoritative; on neon-http it may have moved.
  const asOf = raceFree ? "" : " (as of the latest read)";
  const parts = buildWhereParts(collection.fields, opts.if ?? []);
  const projection: Record<string, SQL> = {};
  parts.forEach((p, i) => {
    projection[`if_${i}`] = sql<boolean>`(${p.sql})`;
  });
  if (opts.increment && incField) {
    const { field, by } = opts.increment;
    projection.exists = sql<boolean>`${entries.data} ? ${field}`;
    const oldValue = sql`(${entries.data}->>${field})::numeric`;
    if (incField.type === "number" && incField.min !== undefined) {
      projection.bmin = sql<boolean>`${oldValue} + ${by} >= ${incField.min}`;
    }
    if (incField.type === "number" && incField.max !== undefined) {
      projection.bmax = sql<boolean>`${oldValue} + ${by} <= ${incField.max}`;
    }
    if (incField.type === "number" && incField.integer) {
      projection.parity = sql<boolean>`${oldValue} % 1 = 0`;
    }
  }
  projection.current = sql<Record<string, unknown>>`${entries.data}`;

  const [row] = await dbc
    .select(projection)
    .from(entries)
    .where(and(eq(entries.id, id), eq(entries.collectionId, collection.id)))
    .limit(1);

  if (!row) return { ok: false, reason: "not_found" };
  const current = row.current as Record<string, unknown>;

  // Precedence: if-clauses, then increment existence, then increment bounds,
  // then a concurrent change. A non-true column (false OR null) means failed.
  const failedGuards = parts.filter((_, i) => row[`if_${i}`] !== true).map((p) => p.label);
  if (failedGuards.length > 0) {
    return {
      ok: false,
      reason: "conflict",
      failedGuards,
      current,
      message: `condition not met${asOf}: ${failedGuards.join("; ")} — re-read and retry`,
    };
  }
  if (opts.increment) {
    const field = opts.increment.field;
    if (row.exists !== true) {
      return {
        ok: false,
        reason: "unset",
        current,
        message: `increment: field "${field}" is not set on this entry — set it with update_entry first`,
      };
    }
    if (row.parity === false) {
      return {
        ok: false,
        reason: "conflict",
        current,
        message: `increment: stored value ${String(current[field])} for integer field "${field}" is not whole (it predates the integer constraint) — fix it with update_entry first`,
      };
    }
    if (row.bmin === false || row.bmax === false) {
      const bound = row.bmin === false ? `below min ${(incField as { min?: number }).min}` : `above max ${(incField as { max?: number }).max}`;
      return {
        ok: false,
        reason: "bounds",
        current,
        message: `increment ${field} by ${opts.increment.by} would go ${bound} — current value is ${String(current[field])}${asOf}`,
      };
    }
  }
  return {
    ok: false,
    reason: "conflict",
    current,
    message: `row changed concurrently between the update and this diagnosis${asOf} — re-read and retry`,
  };
}

/** Validated CAS inputs — produced before the write (and, in transact, before the tx). */
interface CasPlan {
  patch: Record<string, unknown>;
  incField: FieldDef | undefined;
}

/** Validate a CAS op's data/increment. Throws ValidationError on bad input. */
async function prepareUpdateIf(
  projectId: string,
  collection: Collection,
  opts: UpdateIfOpts,
  assumeExisting?: Set<string>,
): Promise<CasPlan> {
  const patch = opts.data !== undefined ? validate(collection.fields, opts.data, true) : {};
  if (opts.data !== undefined) {
    const { refChecks } = buildEntrySchema(collection.fields, true);
    await verifyRefs(projectId, patch, refChecks, assumeExisting);
  }
  if (Object.keys(patch).length === 0 && !opts.increment) {
    throw new ValidationError("update_entry_if needs data and/or increment — nothing to apply");
  }
  let incField: FieldDef | undefined;
  if (opts.increment) {
    const { field, by } = opts.increment;
    incField = collection.fields.find((f) => f.name === field);
    if (!incField || incField.type !== "number") {
      const numberFields = collection.fields.filter((f) => f.type === "number").map((f) => f.name);
      throw new ValidationError(
        `increment: needs a number field — number fields: ${numberFields.join(", ") || "(none)"}`,
      );
    }
    if (field in patch) {
      throw new ValidationError(`increment: "${field}" cannot also appear in data — pick one`);
    }
    if (incField.integer && !Number.isInteger(by)) {
      throw new ValidationError(`increment: by must be a whole number for integer field "${field}"`);
    }
  }
  return { patch, incField };
}

/**
 * The write choke point for compare-and-set. Runs the conditional UPDATE on any
 * executor and, on a 0-row result, diagnoses WHY (race-free when inside a tx).
 * Caller validates first via prepareUpdateIf.
 */
async function updateEntryIfCore(
  dbc: DbExecutor,
  collection: Collection,
  id: string,
  opts: UpdateIfOpts,
  plan: CasPlan,
  raceFree: boolean,
): Promise<
  | { ok: true; entry: Entry; emit: EmitDescriptor; changedFields: string[] }
  | { ok: false; diagnosis: Extract<UpdateIfResult, { ok: false }> }
> {
  const { patch, incField } = plan;
  const conditions = [
    eq(entries.id, id),
    eq(entries.collectionId, collection.id),
    ...buildWhere(collection.fields, opts.if ?? []),
  ];

  // G4: a workflow move on the CAS path. `to` is validated for the actor before
  // SQL; the field must currently be an allowed `from` or the CAS 0-rows as a
  // conflict. The guard is ONLY allowedFroms (NOT ∪ {to}): that makes the
  // single-fire guarantee rest on the target-row WHERE (which Postgres
  // re-evaluates reliably under contention), so N concurrent identical
  // transitions produce exactly one winner and N-1 conflicts — never a
  // double-fire. (Including `to` for idempotency let losers no-op-succeed, and
  // whether they fired then hinged on the racy pre-image. Idempotent B→B now
  // conflicts; use an `if` condition for CAS retries.) The winner's exact `from`
  // is recovered via the self-join UPDATE below.
  const wf = collection.workflow;
  const wfField = wf && wf.field in patch ? wf.field : null;
  let wfTo: string | null = null;
  if (wf && wfField) {
    const actorType = workflowActor(opts.actor ?? UNKNOWN_ACTOR);
    if (!actorType) {
      throw new ValidationError(`workflow: "${wf.field}" can only be changed by a known actor (mcp/admin/delivery)`);
    }
    const check = checkTransition(collection, actorType, patch)!;
    wfTo = check.to;
    const guardVals = [...new Set(check.allowedFroms)];
    conditions.push(
      sql`(${entries.data}->>${wf.field}) = ANY(${sql`ARRAY[${sql.join(
        guardVals.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`})`,
    );
  }

  // null = explicit unset, mirroring update_entry: subtract unset keys, then
  // merge the rest — all inside the single conditional UPDATE.
  const casSets: Record<string, unknown> = {};
  const casUnsets: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) casUnsets.push(k);
    else casSets[k] = v;
  }
  let dataExpr = sql`${entries.data}`;
  for (const k of casUnsets) {
    dataExpr = sql`(${dataExpr} - ${k}::text)`;
  }
  if (Object.keys(casSets).length > 0) {
    dataExpr = sql`${dataExpr} || ${JSON.stringify(casSets)}::jsonb`;
  }

  if (opts.increment && incField && incField.type === "number") {
    const { field, by } = opts.increment;
    const oldValue = sql`(${entries.data}->>${field})::numeric`;
    // The field must exist to increment, and the result must respect min/max —
    // violations surface as a conflict, the book-a-seat semantic ("no seats").
    conditions.push(sql`${entries.data} ? ${field}`);
    if (incField.min !== undefined) conditions.push(sql`${oldValue} + ${by} >= ${incField.min}`);
    if (incField.max !== undefined) conditions.push(sql`${oldValue} + ${by} <= ${incField.max}`);
    // Legacy fractional values (pre-integer knob) conflict rather than
    // silently producing a fractional result.
    if (incField.integer) conditions.push(sql`${oldValue} % 1 = 0`);
    dataExpr = sql`jsonb_set(${dataExpr}, ${`{${field}}`}, to_jsonb(${oldValue} + ${by}))`;
  }

  let row: Entry | undefined;
  // The success event/version want `previous`. For a workflow move `previous`
  // must be the EXACT pre-image (it decides WHICH transition fired), so that
  // path uses a self-join UPDATE returning old.data — an advisory pre-read can
  // misreport `from` when a concurrent writer moves the row mid-CAS, firing the
  // wrong transition or double-firing. Non-workflow CAS keeps the cheaper
  // advisory pre-read (its `previous` is already documented-advisory).
  let previous: Record<string, unknown> | undefined;
  if (wfField) {
    const whereSql = and(...conditions)!;
    try {
      const result = await dbc.execute(sql`
        UPDATE ${entries}
        SET data = ${dataExpr}, updated_at = now()
        FROM ${entries} old
        WHERE ${entries.id} = old.id AND ${whereSql}
        RETURNING ${entries.id} AS id, ${entries.data} AS data, old.data AS previous_data`);
      const rows = ((result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])) as {
        id: string;
        data: Record<string, unknown>;
        previous_data: Record<string, unknown>;
      }[];
      if (rows[0]) {
        row = { id: rows[0].id, data: rows[0].data } as Entry;
        previous = rows[0].previous_data;
      }
    } catch (e) {
      rethrowUnique(e);
    }
  } else {
    const [preRead] = await dbc
      .select()
      .from(entries)
      .where(and(eq(entries.id, id), eq(entries.collectionId, collection.id)))
      .limit(1);
    previous = preRead?.data;
    try {
      [row] = await dbc
        .update(entries)
        .set({ data: dataExpr as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();
    } catch (e) {
      rethrowUnique(e);
    }
  }

  if (!row) {
    const diagnosis = await diagnoseCasFailure(dbc, collection, id, opts, incField, raceFree);
    return { ok: false, diagnosis };
  }
  // `from` is now the EXACT pre-image on the workflow path — fire only on a real
  // move (from !== to), so a racer landing on an already-`to` row fires nothing.
  let transition: EmitDescriptor["transition"];
  if (wfField && wfTo !== null) {
    const from = previous?.[wfField];
    if (typeof from === "string" && from !== wfTo) transition = { field: wfField, from, to: wfTo };
  }
  return {
    ok: true,
    entry: row,
    emit: { event: "updated", entry: { id: row.id, data: row.data }, previous, transition },
    changedFields: [...Object.keys(patch), ...(opts.increment ? [opts.increment.field] : [])],
  };
}

/**
 * Compare-and-set in ONE SQL statement — the 80/20 of transactions
 * (book-a-seat) with zero code execution. The if-conditions AND the field's
 * min/max constraint guards live in the UPDATE's WHERE clause, so concurrent
 * writers serialize on the row instead of racing validation.
 */
export async function updateEntryIf(
  projectId: string,
  collection: Collection,
  id: string,
  opts: UpdateIfOpts,
): Promise<UpdateIfResult> {
  const plan = await prepareUpdateIf(projectId, collection, opts);
  const result = await updateEntryIfCore(db, collection, id, opts, plan, false);
  if (!result.ok) return result.diagnosis;

  const { entry, emit, changedFields } = result;
  const actor = opts.actor ?? UNKNOWN_ACTOR;
  // CAS carries a pre-image too (advisory pre-read, or the G4b self-join on the
  // workflow path), so CAS updates get feed tombstones like plain updates.
  await recordChange({
    projectId,
    collection,
    kind: "updated",
    entryId: entry.id,
    data: entry.data,
    prevData: emit.previous,
    changedFields,
  });
  defer(() => emitEntryEvent(collection, emit.event, emit.entry, emit.previous));
  fireTransition(collection, emit);
  // C8: CAS captures a version too, from the advisory pre-read (not a self-join).
  if (emit.previous) {
    recordVersion({
      projectId,
      collectionId: collection.id,
      entryId: entry.id,
      data: emit.previous,
      changedFields,
      actor,
    });
  }
  recordAudit({
    projectId,
    collectionName: collection.name,
    entryId: entry.id,
    action: "update",
    actor,
    changedFields,
  });
  return { ok: true, entry };
}

/**
 * Restore an entry to a past version's snapshot. The snapshot is run through the
 * FULL write pipeline against the CURRENT schema (strict validate + verifyRefs),
 * so an incompatible old snapshot (dropped/added fields) is rejected rather than
 * silently corrupting the row. The pre-restore state is itself captured as a
 * version, so a restore is undoable. The entry must be live (restore it from
 * trash first).
 */
export async function restoreEntryVersion(
  projectId: string,
  collection: Collection,
  entryId: string,
  versionId: string,
  actor: AuditActor = UNKNOWN_ACTOR,
): Promise<Entry> {
  const [version] = await db
    .select()
    .from(entryVersions)
    .where(
      and(
        eq(entryVersions.id, versionId),
        eq(entryVersions.projectId, projectId),
        eq(entryVersions.entryId, entryId),
      ),
    )
    .limit(1);
  if (!version) {
    throw new ValidationError(`no version ${versionId} for entry ${entryId}`, "E_NOT_FOUND");
  }

  // STORAGE mode: a version snapshot legitimately CONTAINS its computed values;
  // a restore reverts to the exact prior state (old slug/uuid/timestamp kept),
  // so those keys are valid input here, not client-supplied ones to reject.
  const clean = validate(collection.fields, version.data, false, "storage");
  const { refChecks } = buildEntrySchema(collection.fields);
  await verifyRefs(projectId, clean, refChecks);

  const [current] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.id, entryId), eq(entries.collectionId, collection.id)))
    .limit(1);
  if (!current) {
    throw new ValidationError(
      `entry ${entryId} is not live — restore it from trash before restoring a version`,
      "E_NOT_FOUND",
    );
  }

  // Restore is CONTENT time-travel, not a workflow transition: never move the
  // state-machine field outside a declared, actor-gated transition. Pin it to
  // the live value so an old snapshot can't reverse actor-gated progress
  // (e.g. published→draft) by sidestepping the transition check.
  const wf = collection.workflow;
  if (wf && wf.field in clean && clean[wf.field] !== current.data[wf.field]) {
    clean[wf.field] = current.data[wf.field];
  }

  let row: Entry | undefined;
  try {
    [row] = await db
      .update(entries)
      .set({ data: clean, updatedAt: new Date() })
      .where(eq(entries.id, entryId))
      .returning();
  } catch (e) {
    rethrowUnique(e);
  }
  if (!row) throw new ValidationError(`entry ${entryId} not found`, "E_NOT_FOUND");

  const changedFields = Object.keys({ ...current.data, ...clean }).filter(
    (k) => JSON.stringify(current.data[k]) !== JSON.stringify(clean[k]),
  );
  await recordChange({
    projectId,
    collection,
    kind: "updated",
    entryId,
    data: row.data,
    prevData: current.data,
    changedFields,
  });
  defer(() => emitEntryEvent(collection, "updated", { id: row.id, data: row.data }, current.data));
  recordVersion({
    projectId,
    collectionId: collection.id,
    entryId,
    data: current.data,
    changedFields,
    actor,
  });
  recordAudit({
    projectId,
    collectionName: collection.name,
    entryId,
    action: "update",
    actor,
    changedFields,
  });
  return row;
}

/**
 * The write choke point for deletes — a soft delete that MOVES the row from
 * `entries` to `entries_trash` in one data-modifying CTE (atomic on the
 * transaction-less neon-http driver, the same idiom as updateEntryIf). Returns
 * null when no row matched, so the caller decides policy: delete_entry treats it
 * as a silent no-op, transact aborts the batch. The emitted event stays
 * `deleted` — the row is gone from the live collection, just recoverable.
 */
async function deleteEntryCore(
  dbc: DbExecutor,
  collection: Collection,
  id: string,
  actor: AuditActor,
): Promise<{ entry: { id: string; data: Record<string, unknown> }; emit: EmitDescriptor } | null> {
  const result = await dbc.execute(sql`
    WITH moved AS (
      DELETE FROM ${entries}
      WHERE ${entries.id} = ${id} AND ${entries.collectionId} = ${collection.id}
      RETURNING *
    )
    INSERT INTO ${entriesTrash}
      (id, project_id, collection_id, data, idempotency_key, handled_at, created_at, updated_at, deleted_by)
    SELECT id, project_id, collection_id, data, idempotency_key, handled_at, created_at, updated_at,
           ${JSON.stringify(actor)}::jsonb
    FROM moved
    RETURNING id, data
  `);
  const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  const row = (Array.isArray(rows) ? rows[0] : undefined) as
    | { id: string; data: Record<string, unknown> }
    | undefined;
  if (!row) return null;
  return { entry: row, emit: { event: "deleted", entry: { id: row.id, data: row.data } } };
}

/** Retention: purge trash older than 30 days AND reap its version history in one
 *  statement. Opportunistic + error-swallowed, deferred from the delete path and
 *  list_trash. */
export async function sweepExpiredTrash(projectId: string): Promise<void> {
  await db
    .execute(
      sql`
        WITH swept AS (
          DELETE FROM ${entriesTrash}
          WHERE ${entriesTrash.projectId} = ${projectId}
            AND ${entriesTrash.deletedAt} < now() - interval '30 days'
          RETURNING id
        )
        DELETE FROM ${entryVersions} WHERE ${entryVersions.entryId} IN (SELECT id FROM swept)
      `,
    )
    .catch(() => {});
}

export async function deleteEntry(
  collection: Collection,
  id: string,
  actor: AuditActor = UNKNOWN_ACTOR,
): Promise<void> {
  const result = await deleteEntryCore(db, collection, id, actor);
  if (result) {
    const { entry, emit } = result;
    // Feed tombstone (pre-delete snapshot) — inline so a synced client converges.
    await recordChange({
      projectId: collection.projectId,
      collection,
      kind: "deleted",
      entryId: entry.id,
      data: entry.data,
    });
    defer(() => emitEntryEvent(collection, emit.event, emit.entry, emit.previous));
    defer(() => sweepExpiredTrash(collection.projectId));
    recordAudit({
      projectId: collection.projectId,
      collectionName: collection.name,
      entryId: entry.id,
      action: "delete",
      actor,
    });
  }
}

export interface TransactOp {
  op: "create" | "update" | "delete" | "update_if";
  collection: string;
  id?: string;
  data?: unknown;
  /** create only: name this op so a later op can reference its id as "$ref:<name>". */
  ref?: string;
  /** update_if only. */
  if?: WhereItem[];
  increment?: { field: string; by: number };
}

export interface TransactPlanItem {
  index: number;
  op: string;
  collection: string;
  id?: string;
}

export type TransactOutcome =
  | { applied: true; replayed?: boolean; results: TransactResult[] }
  | { applied: false; dryRun: true; plan: TransactPlanItem[] };

/** Thrown to roll back when an idempotencyKey was already used — triggers a replay. */
class ReplaySignal extends Error {}

const REF_RE = /^\$ref:([a-z][a-z0-9_]*)$/;
const REF_NAME_RE = /^[a-z][a-z0-9_]*$/;

export interface TransactResult {
  op: string;
  collection: string;
  id: string;
}

/** Aborts a transact batch; carries which op failed and its underlying code. */
export class TransactError extends Error {
  readonly opIndex: number;
  readonly code: ErrorCode;
  constructor(opIndex: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "TransactError";
    this.opIndex = opIndex;
    this.code = code;
  }
}

/**
 * All-or-nothing batch of entry ops in ONE interactive transaction. Every op is
 * validated + ref-checked BEFORE the transaction opens (create ids are
 * pre-generated); then the cores run sequentially inside `withTransaction`. Any
 * failure — validation, unique violation, or a delete/update hitting no row —
 * throws TransactError and rolls the whole batch back. Events + audit fire only
 * after commit, in op order. Deliberately stricter than delete_entry: a delete
 * op on a missing id aborts the batch (E_NOT_FOUND) instead of a silent no-op.
 */
export async function transact(
  projectId: string,
  ops: TransactOp[],
  actor: AuditActor = UNKNOWN_ACTOR,
  runOpts: { dryRun?: boolean; idempotencyKey?: string } = {},
): Promise<TransactOutcome> {
  const collCache = new Map<string, Collection>();
  const resolve = async (name: string, opIndex: number): Promise<Collection> => {
    const cached = collCache.get(name);
    if (cached) return cached;
    const c = await getCollection(projectId, name);
    if (!c) throw new TransactError(opIndex, "E_NOT_FOUND", `collection "${name}" not found`);
    collCache.set(name, c);
    return c;
  };

  // Pass 1: resolve collections, pre-generate every create's id, register refs.
  const opCollections: Collection[] = [];
  const createIds: (string | undefined)[] = [];
  const refMap = new Map<string, { uuid: string; collection: Collection; opIndex: number }>();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    opCollections[i] = await resolve(op.collection, i);
    if (op.op === "create") {
      const uuid = randomUUID();
      createIds[i] = uuid;
      if (op.ref !== undefined) {
        if (!REF_NAME_RE.test(op.ref)) {
          throw new TransactError(i, "E_VALIDATION", `ref "${op.ref}" must be snake_case starting with a letter`);
        }
        if (refMap.has(op.ref)) {
          throw new TransactError(i, "E_VALIDATION", `duplicate ref "${op.ref}" in this batch`);
        }
        refMap.set(op.ref, { uuid, collection: opCollections[i], opIndex: i });
      }
    } else if (op.ref !== undefined) {
      throw new TransactError(i, "E_VALIDATION", "ref is only valid on create ops");
    }
  }

  // A "$ref:<name>" sentinel resolves to an earlier create's id. It is honored
  // ONLY in an op.id position and in relation-typed fields; anywhere else (e.g.
  // a text field) it is stored literally.
  const resolveRef = (raw: string, i: number, context: string) => {
    const m = REF_RE.exec(raw);
    if (!m) return null;
    const target = refMap.get(m[1]);
    if (!target) {
      throw new TransactError(i, "E_VALIDATION", `${context}: $ref:${m[1]} names no create op in this batch`);
    }
    if (target.opIndex >= i) {
      throw new TransactError(i, "E_VALIDATION", `${context}: $ref:${m[1]} — refs may only point to earlier create ops — reorder the ops`);
    }
    return target;
  };

  // Pass 2: substitute $refs, then validate + verifyRefs (skipping same-batch ids).
  const assumeExisting = new Set(createIds.filter((x): x is string => Boolean(x)));
  interface Prepared {
    kind: TransactOp["op"];
    collection: Collection;
    id: string; // create: generated up front; other ops: the resolved id
    clean?: Record<string, unknown>;
    changedFields?: string[];
    casOpts?: UpdateIfOpts; // update_if
    casPlan?: CasPlan; // update_if
  }
  const prepared: Prepared[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const collection = opCollections[i];
    try {
      let id = op.id;
      if (typeof id === "string") {
        const r = resolveRef(id, i, "id");
        if (r) id = r.uuid;
      }
      // Substitute $ref in relation fields (ops that carry a data patch).
      let data = op.data;
      const carriesData = op.op === "create" || op.op === "update" || op.op === "update_if";
      if (data && typeof data === "object" && carriesData) {
        const copy = { ...(data as Record<string, unknown>) };
        for (const f of collection.fields) {
          if (f.type !== "relation") continue;
          const v = copy[f.name];
          if (typeof v !== "string") continue;
          const r = resolveRef(v, i, `field "${f.name}"`);
          if (!r) continue;
          if (r.collection.name !== f.targetCollection) {
            throw new TransactError(
              i,
              "E_VALIDATION",
              `field "${f.name}" targets "${f.targetCollection}" but its $ref creates in "${r.collection.name}"`,
            );
          }
          copy[f.name] = r.uuid;
        }
        data = copy;
      }

      if (op.op === "create") {
        const clean = validate(collection.fields, data, false);
        applyWorkflowOnCreate(collection, clean); // initial-state rule on the transact create path too
        const { refChecks } = buildEntrySchema(collection.fields);
        await verifyRefs(projectId, clean, refChecks, assumeExisting);
        // The before-create hook gates transact creates too — consulted HERE in
        // the prep pass, BEFORE withTransaction opens, so the synchronous
        // external call never holds the pooled connection and a rejection aborts
        // the whole batch cleanly (nothing has been written yet). transact is
        // full-trust (MCP), so no identity re-stamp applies; pass assumeExisting
        // so a transform's re-verifyRefs accepts same-batch $refs.
        const hooked = await runBeforeCreateHook(projectId, collection, clean, undefined, assumeExisting);
        const toWrite = collection.fields.some((f) => f.computed)
          ? validate(collection.fields, evaluateComputed(collection.fields, hooked), false, "storage")
          : hooked;
        prepared.push({ kind: "create", collection, id: createIds[i]!, clean: toWrite, changedFields: Object.keys(toWrite) });
      } else if (op.op === "update") {
        if (!id) throw new ValidationError("update op requires an id");
        const clean = validate(collection.fields, data, true);
        const { refChecks } = buildEntrySchema(collection.fields, true);
        await verifyRefs(projectId, clean, refChecks, assumeExisting);
        prepared.push({ kind: "update", collection, id, clean, changedFields: Object.keys(clean) });
      } else if (op.op === "update_if") {
        if (!id) throw new ValidationError("update_if op requires an id");
        const casOpts: UpdateIfOpts = { if: op.if, data, increment: op.increment, actor };
        const casPlan = await prepareUpdateIf(projectId, collection, casOpts, assumeExisting);
        prepared.push({ kind: "update_if", collection, id, casOpts, casPlan });
      } else {
        if (!id) throw new ValidationError("delete op requires an id");
        prepared.push({ kind: "delete", collection, id });
      }
    } catch (e) {
      if (e instanceof TransactError) throw e;
      if (e instanceof ValidationError) throw new TransactError(i, e.code, e.message);
      throw e;
    }
  }

  // Relation integrity across the batch: pre-tx verifyRefs runs on committed
  // state, so it can't see that another op in THIS batch deletes a row being
  // related to. Reject that contradiction (a row cannot be both deleted and
  // referenced in one batch) rather than commit a dangling relation.
  const deleteTargets = new Set(prepared.filter((p) => p.kind === "delete").map((p) => p.id));
  if (deleteTargets.size > 0) {
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      const data = p.clean ?? p.casPlan?.patch;
      if (!data) continue;
      for (const f of p.collection.fields) {
        if (f.type !== "relation") continue;
        const v = data[f.name];
        if (typeof v === "string" && deleteTargets.has(v)) {
          throw new TransactError(
            i,
            "E_VALIDATION",
            `field "${f.name}" references ${v}, which another op in this batch deletes — a batch cannot both delete a row and relate to it`,
          );
        }
      }
    }
  }

  // dryRun: everything above proves the batch is well-formed (any failure already
  // threw an op-indexed error). Report the plan without opening a transaction.
  // update_if conditions are still only evaluated at execute time — dryRun cannot
  // pre-check a race.
  if (runOpts.dryRun) {
    return {
      applied: false,
      dryRun: true,
      plan: prepared.map((p, i) => ({ index: i, op: ops[i].op, collection: p.collection.name, id: p.id })),
    };
  }

  const emitPlan: { collection: Collection; emit: EmitDescriptor }[] = [];
  const changePlan: ChangeInput[] = [];
  const auditPlan: {
    collection: Collection;
    id: string;
    action: "create" | "update" | "delete";
    changedFields?: string[];
  }[] = [];
  const versionPlan: {
    collection: Collection;
    entryId: string;
    previous: Record<string, unknown>;
    changedFields?: string[];
  }[] = [];
  // Every result id is known before execution: create ids are pre-generated,
  // all others are the resolved input ids. This lets the idempotency receipt be
  // written as the FIRST statement in the transaction, with the complete result.
  const results: TransactResult[] = prepared.map((p) => ({
    op: p.kind,
    collection: p.collection.name,
    id: p.id,
  }));

  try {
    await withTransaction(async (tx) => {
      if (runOpts.idempotencyKey) {
        // First statement: claim the key. A duplicate means this batch already
        // ran — abort (rolling back before any op) and replay the stored result.
        try {
          await tx.insert(transactReceipts).values({
            projectId,
            idempotencyKey: runOpts.idempotencyKey,
            results,
          });
        } catch (e) {
          if (/transact_receipts_key_idx/.test(dbErrorText(e))) throw new ReplaySignal();
          throw e;
        }
      }
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        try {
          if (p.kind === "create") {
            const { emit } = await createEntryCore(tx, projectId, p.collection, p.clean!, { id: p.id });
            if (emit) {
              emitPlan.push({ collection: p.collection, emit });
              changePlan.push({ projectId, collection: p.collection, kind: "created", entryId: p.id, data: emit.entry.data ?? {} });
            }
            auditPlan.push({ collection: p.collection, id: p.id, action: "create", changedFields: p.changedFields });
          } else if (p.kind === "update") {
            const { emit } = await updateEntryCore(tx, p.collection, p.id, p.clean!, workflowActor(actor));
            emitPlan.push({ collection: p.collection, emit });
            changePlan.push({ projectId, collection: p.collection, kind: "updated", entryId: p.id, data: emit.entry.data ?? {}, prevData: emit.previous, changedFields: p.changedFields });
            auditPlan.push({ collection: p.collection, id: p.id, action: "update", changedFields: p.changedFields });
            if (emit.previous) {
              versionPlan.push({ collection: p.collection, entryId: p.id, previous: emit.previous, changedFields: p.changedFields });
            }
          } else if (p.kind === "update_if") {
            // Race-free diagnosis: the diagnostic SELECT runs on the tx executor,
            // so it sees exactly the row the UPDATE saw.
            const r = await updateEntryIfCore(tx, p.collection, p.id, p.casOpts!, p.casPlan!, true);
            if (!r.ok) {
              const code = r.diagnosis.reason === "not_found" ? "E_NOT_FOUND" : "E_CONFLICT";
              throw new TransactError(i, code, `update_if "${p.collection.name}": ${r.diagnosis.message}`);
            }
            emitPlan.push({ collection: p.collection, emit: r.emit });
            changePlan.push({ projectId, collection: p.collection, kind: "updated", entryId: p.id, data: r.emit.entry.data ?? {}, prevData: r.emit.previous, changedFields: r.changedFields });
            auditPlan.push({ collection: p.collection, id: p.id, action: "update", changedFields: r.changedFields });
            if (r.emit.previous) {
              versionPlan.push({ collection: p.collection, entryId: p.id, previous: r.emit.previous, changedFields: r.changedFields });
            }
          } else {
            const del = await deleteEntryCore(tx, p.collection, p.id, actor);
            if (!del) throw new ValidationError(`no entry ${p.id} in "${p.collection.name}"`, "E_NOT_FOUND");
            emitPlan.push({ collection: p.collection, emit: del.emit });
            changePlan.push({ projectId, collection: p.collection, kind: "deleted", entryId: p.id, data: del.emit.entry.data ?? {} });
            auditPlan.push({ collection: p.collection, id: p.id, action: "delete" });
          }
        } catch (e) {
          if (e instanceof TransactError || e instanceof ReplaySignal) throw e;
          if (e instanceof ValidationError) throw new TransactError(i, e.code, e.message);
          throw new TransactError(i, "E_INTERNAL", e instanceof Error ? e.message : String(e));
        }
      }
    });
  } catch (e) {
    if (e instanceof ReplaySignal) {
      // The batch was already applied under this key — return the stored result.
      const [receipt] = await db
        .select()
        .from(transactReceipts)
        .where(
          and(
            eq(transactReceipts.projectId, projectId),
            eq(transactReceipts.idempotencyKey, runOpts.idempotencyKey!),
          ),
        )
        .limit(1);
      return { applied: true, replayed: true, results: (receipt?.results as TransactResult[]) ?? [] };
    }
    throw e;
  }

  // Committed — record the change feed synchronously (post-commit; the batch is
  // atomic, so this is one insert for all rows), then fan out events deferred.
  await recordChanges(changePlan);
  defer(async () => {
    for (const { collection, emit } of emitPlan) {
      await emitEntryEvent(collection, emit.event, emit.entry, emit.previous);
      fireTransition(collection, emit); // transact updates fire transition actions too
    }
  });
  for (const a of auditPlan) {
    recordAudit({
      projectId,
      collectionName: a.collection.name,
      entryId: a.id,
      action: a.action,
      actor,
      changedFields: a.changedFields,
    });
  }
  for (const v of versionPlan) {
    recordVersion({
      projectId,
      collectionId: v.collection.id,
      entryId: v.entryId,
      data: v.previous,
      changedFields: v.changedFields,
      actor,
    });
  }
  return { applied: true, results };
}

export async function getEntry(collection: Collection, id: string): Promise<Entry | null> {
  const [row] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.id, id), eq(entries.collectionId, collection.id)))
    .limit(1);
  return row ?? null;
}

export async function countEntries(
  collection: Collection,
  where: WhereItem[] = [],
  related?: RelatedContextMap,
): Promise<number> {
  const conditions = [
    eq(entries.collectionId, collection.id),
    ...buildWhere(collection.fields, where, related),
  ];
  const [row] = await db
    .select({ n: count() })
    .from(entries)
    .where(and(...conditions));
  return row?.n ?? 0;
}

export interface BulkItemResult {
  index: number;
  ok: boolean;
  id?: string;
  error?: string;
  /** Structured mirror of `error` — present on validation-shaped item failures. */
  issues?: ConstraintIssue[];
}

/**
 * Validate every item, then insert all valid ones in ONE statement. Per-item
 * results so an agent can fix just its failures — a partial seed beats an
 * all-or-nothing retry of 50 round-trips.
 */
export async function bulkCreateEntries(
  projectId: string,
  collection: Collection,
  items: unknown[],
  actor: AuditActor = UNKNOWN_ACTOR,
): Promise<BulkItemResult[]> {
  if (items.length > 100) throw new ValidationError("max 100 entries per bulk call");
  // I1a: bulk does NOT run before-create hooks (a synchronous per-item consult
  // would blow the host budget). Refuse rather than silently skip the hook.
  if (collection.hooks?.beforeCreate && !collection.hooks.beforeCreate.disabled) {
    throw new ValidationError(
      `"${collection.name}" has a beforeCreate hook — use create_entry per item, or set hooks.beforeCreate.disabled to bulk-insert`,
    );
  }
  const { refChecks } = buildEntrySchema(collection.fields);
  const hasComputed = collection.fields.some((f) => f.computed);

  const results: BulkItemResult[] = [];
  const valid: { index: number; clean: Record<string, unknown> }[] = [];
  await Promise.all(
    items.map(async (item, index) => {
      try {
        const clean = validate(collection.fields, item, false);
        applyWorkflowOnCreate(collection, clean); // same initial-state rule as createEntry
        await verifyRefs(projectId, clean, refChecks);
        // I3: stamp computed per item (distinct now/uuid each), then STORAGE-validate.
        const toStore = hasComputed
          ? validate(collection.fields, evaluateComputed(collection.fields, clean), false, "storage")
          : clean;
        valid.push({ index, clean: toStore });
      } catch (e) {
        results.push({
          index,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          ...(e instanceof ValidationError && e.issues?.length ? { issues: e.issues } : {}),
        });
      }
    }),
  );

  if (valid.length > 0) {
    // One multi-row insert; a unique violation fails the whole batch with the
    // field named, rather than paying a round-trip per item.
    let rows: Entry[];
    try {
      rows = await db
        .insert(entries)
        .values(
          valid.map((v) => ({ projectId, collectionId: collection.id, data: v.clean })),
        )
        .returning();
    } catch (e) {
      rethrowUnique(e);
    }
    // One multi-row feed insert for the whole batch (inline, before side-work).
    await recordChanges(
      rows.map((created) => ({
        projectId,
        collection,
        kind: "created" as const,
        entryId: created.id,
        data: created.data,
      })),
    );
    valid.forEach((v, i) => {
      results.push({ index: v.index, ok: true, id: rows[i].id });
      const created = rows[i];
      defer(() => emitEntryEvent(collection, "created", { id: created.id, data: created.data }));
      recordAudit({
        projectId,
        collectionName: collection.name,
        entryId: rows[i].id,
        action: "create",
        actor,
        changedFields: Object.keys(v.clean),
      });
    });
  }
  return results.sort((a, b) => a.index - b.index);
}

export interface QueryOpts {
  limit?: number;
  offset?: number;
  where?: WhereItem[];
  orderBy?: OrderByClause;
  /** Keyset position from decodeCursor — only valid with the default ordering. */
  after?: { createdAt: Date; id: string };
  /** Authorizes dotted `relationField.targetField` clauses (collectRelatedTargets). */
  related?: RelatedContextMap;
}

/**
 * Build the per-relation context that authorizes dotted `relationField.targetField`
 * where-clauses. Scans the where[] for dotted heads, resolves each head's target
 * collection, and sets the surface policy: 'mcp' reads bypass the target's row
 * gates (allowedOps = all, no gate); 'delivery' reads restrict the tail to
 * publicRead fields, allow eq/in only, and AND the target's publicFilter inside
 * the EXISTS so a match implies the related row is publicly visible.
 */
export async function collectRelatedTargets(
  projectId: string,
  collection: Collection,
  where: WhereItem[],
  policy: "mcp" | "delivery",
): Promise<RelatedContextMap | undefined> {
  const heads = new Set<string>();
  const scanClause = (c: WhereItem) => {
    if ("anyOf" in c) {
      for (const x of c.anyOf) {
        const i = x.field.indexOf(".");
        if (i > 0) heads.add(x.field.slice(0, i));
      }
    } else {
      const i = c.field.indexOf(".");
      if (i > 0) heads.add(c.field.slice(0, i));
    }
  };
  for (const item of where) scanClause(item);
  if (heads.size === 0) return undefined;

  const map: RelatedContextMap = new Map();
  const allOps = new Set(WHERE_OPS);
  const deliveryOps = new Set<WhereOp>(["eq", "in"]);
  for (const head of heads) {
    const headField = collection.fields.find((f) => f.name === head);
    if (!headField || headField.type !== "relation") continue; // compiler throws a precise error
    const target = await getCollection(projectId, headField.targetCollection);
    if (!target) continue;
    map.set(head, {
      collectionId: target.id,
      queryFields: policy === "delivery" ? publicFields(target) : target.fields,
      gateFields: target.fields,
      gateClauses: policy === "delivery" ? ((target.publicFilter as WhereItem[] | null) ?? []) : [],
      allowedOps: policy === "delivery" ? deliveryOps : allOps,
    });
  }
  return map;
}

/** Opaque cursor over the default (createdAt, id) ordering. */
export function encodeCursor(row: Entry): string {
  return Buffer.from(
    JSON.stringify({ t: row.createdAt.toISOString(), id: row.id }),
  ).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
      t?: unknown;
      id?: unknown;
    };
    const createdAt = new Date(String(parsed.t));
    if (Number.isNaN(createdAt.getTime()) || typeof parsed.id !== "string" || !parsed.id) {
      throw new Error("bad cursor");
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new ValidationError(
      "invalid cursor — pass the nextCursor returned by a previous query_entries page",
    );
  }
}

export const MAX_QUERY_LIMIT = 500;

export interface EntryPage {
  rows: Entry[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Page-aware query: fetches limit+1 rows so hasMore is exact, never a guess.
 * Without an explicit orderBy, rows are ordered by (createdAt, id) — pagination
 * needs a total order or pages can overlap/skip.
 */
export async function queryEntriesPage(
  collection: Collection,
  opts: QueryOpts = {},
): Promise<EntryPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, MAX_QUERY_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);
  const conditions = [
    eq(entries.collectionId, collection.id),
    ...buildWhere(collection.fields, opts.where ?? [], opts.related),
  ];
  // Cursor keys truncate to milliseconds because JS Dates lose Postgres's
  // microseconds — both sides of the keyset comparison must share a precision,
  // and the default ordering must sort by the exact same key.
  const createdMs = sql`date_trunc('milliseconds', ${entries.createdAt})`;
  if (opts.after) {
    if (opts.orderBy) {
      throw new ValidationError(
        "cursor pagination uses the default (createdAt, id) ordering — drop orderBy, or page with offset instead",
      );
    }
    conditions.push(
      sql`(${createdMs}, ${entries.id}) > (${opts.after.createdAt.toISOString()}::timestamptz, ${opts.after.id}::uuid)`,
    );
  }
  const order = buildOrderBy(collection.fields, opts.orderBy);

  let q = db.select().from(entries).where(and(...conditions)).$dynamic();
  q = order ? q.orderBy(order, entries.id) : q.orderBy(createdMs, entries.id);
  const rows = await q.limit(limit + 1).offset(offset);
  return { rows: rows.slice(0, limit), limit, offset, hasMore: rows.length > limit };
}

export async function queryEntries(
  collection: Collection,
  opts: QueryOpts = {},
): Promise<Entry[]> {
  return (await queryEntriesPage(collection, opts)).rows;
}

/**
 * The reader whose org scope gates relation labels: a verified delivery viewer
 * (EndUser), an anonymous delivery viewer (null), or a trusted authoring surface
 * — MCP/admin — that sees every label ("trusted"). Delivery routes pass their
 * gate.user; MCP/admin pass "trusted".
 */
export type ReadViewer = EndUser | null | "trusted";

/**
 * Resolve relation values on a set of entries to { id, label } using each
 * relation's labelField. ONE query for all referenced ids across every
 * relation field, regardless of how many relation fields the schema has.
 *
 * For a target collection with access.org, the label is gated by the viewer's
 * org (fail-closed) — a delivery viewer only sees labels of same-org target
 * rows; "trusted" surfaces see all. Without this the {id,label} channel would
 * leak an org-scoped labelField cross-tenant (a parent row need not itself be
 * org-scoped to point at an org-scoped target).
 */
export async function resolveRelations(
  projectId: string,
  collection: Collection,
  rows: Entry[],
  viewer?: ReadViewer,
): Promise<Entry[]> {
  const relationFields = collection.fields.filter(
    (f): f is Extract<FieldDef, { type: "relation" }> => f.type === "relation",
  );
  if (relationFields.length === 0 || rows.length === 0) return rows;

  const allIds = new Set<string>();
  for (const rf of relationFields) {
    for (const r of rows) {
      const v = r.data[rf.name];
      if (typeof v === "string") allIds.add(v);
    }
  }
  if (allIds.size === 0) return rows;

  // Entry ids are globally unique — one fetch covers every target collection.
  const targetRows = await db
    .select({ id: entries.id, data: entries.data })
    .from(entries)
    .where(and(inArray(entries.id, [...allIds]), eq(entries.projectId, projectId)));
  const byId = new Map(targetRows.map((t) => [t.id, t.data]));

  // Org-scoped targets: the label channel must honour the target's row scope, or
  // it leaks a cross-org labelField (a parent row need not be org-scoped to point
  // at an org-scoped target). Resolve the target's access.org once per field and
  // only reveal the label to a viewer in the same org — fail-closed for an
  // anonymous viewer or absent/non-string org claim.
  const trusted = viewer === "trusted";
  const viewerUser = trusted ? null : (viewer ?? null);
  const orgByTarget = new Map<string, { field: string; claim: string } | null>();
  if (!trusted) {
    for (const rf of relationFields) {
      if (!orgByTarget.has(rf.targetCollection)) {
        const tc = await getCollection(projectId, rf.targetCollection);
        const org = tc?.access?.org;
        orgByTarget.set(rf.targetCollection, org ? { field: org.field, claim: org.claim } : null);
      }
    }
  }

  for (const rf of relationFields) {
    const org = trusted ? null : orgByTarget.get(rf.targetCollection);
    const viewerOrg = org && viewerUser ? orgClaimValue(viewerUser, org.claim) : null;
    for (const r of rows) {
      const v = r.data[rf.name];
      if (typeof v === "string" && byId.has(v)) {
        const data = byId.get(v)!;
        const crossOrg = org && (viewerOrg === null || data[org.field] !== viewerOrg);
        r.data[rf.name] = crossOrg
          ? { id: v, label: v } // fail-closed: never disclose an out-of-org label
          : { id: v, label: String(data[rf.labelField] ?? v) };
      }
    }
  }
  return rows;
}

/**
 * Resolve asset values on a set of entries to { id, url } — same batched
 * pattern as relations. Without this, delivery consumers get bare uuids and
 * agents invent dual-field workarounds (see experiment friction log F2).
 */
export async function resolveAssets(
  projectId: string,
  collection: Collection,
  rows: Entry[],
): Promise<Entry[]> {
  const assetFields = collection.fields.filter((f) => f.type === "asset");
  if (assetFields.length === 0 || rows.length === 0) return rows;

  const ids = new Set<string>();
  for (const f of assetFields) {
    for (const r of rows) {
      const v = r.data[f.name];
      if (typeof v === "string") ids.add(v);
    }
  }
  if (ids.size === 0) return rows;

  const found = await db
    .select({ id: assets.id, url: assets.url, contentType: assets.contentType })
    .from(assets)
    .where(and(inArray(assets.id, [...ids]), eq(assets.projectId, projectId)));
  const byId = new Map(found.map((a) => [a.id, a]));

  for (const f of assetFields) {
    for (const r of rows) {
      const v = r.data[f.name];
      const a = typeof v === "string" ? byId.get(v) : undefined;
      // contentType (J2) is additive — lets a consumer know when the
      // /assets/{id}/image transform URL applies (raster images only).
      if (a) r.data[f.name] = { id: a.id, url: a.url, contentType: a.contentType };
    }
  }
  return rows;
}

/** Relations + assets in one pass (disjoint fields — safe to run together). */
export async function resolveRefsForRead(
  projectId: string,
  collection: Collection,
  rows: Entry[],
  viewer?: ReadViewer,
): Promise<Entry[]> {
  await Promise.all([
    resolveRelations(projectId, collection, rows, viewer),
    resolveAssets(projectId, collection, rows),
  ]);
  return rows;
}

/**
 * Depth-1 relation expansion: replace named relation values with
 * { id, label, data } — a superset of the { id, label } resolveRelations gives.
 * `data` is the target record with ITS refs resolved, and (mode 'public') its
 * per-field publicRead projection applied — so an expanded record looks exactly
 * like a direct read of the target. Targets are read from `entries` only, so a
 * relation pointing at a trashed row does not expand (no trash leak).
 *
 * Call BEFORE resolveRefsForRead: it turns expanded fields into objects, which
 * resolveRelations then skips (it only touches string values).
 */
export async function expandRelations(
  projectId: string,
  collection: Collection,
  rows: Entry[],
  expand: string[],
  mode: "full" | "public",
  viewer?: ReadViewer,
): Promise<Entry[]> {
  if (expand.length === 0 || rows.length === 0) return rows;

  const expandFields = expand.map((name) => {
    const f = collection.fields.find((x) => x.name === name);
    if (!f || f.type !== "relation") {
      const expandable = collection.fields.filter((x) => x.type === "relation").map((x) => x.name);
      throw new ValidationError(
        `expand: "${name}" is not a relation field — expandable: ${expandable.join(", ") || "(none)"}`,
      );
    }
    return f as Extract<FieldDef, { type: "relation" }>;
  });

  // Referenced ids grouped by target collection.
  const idsByTarget = new Map<string, Set<string>>();
  for (const rf of expandFields) {
    for (const r of rows) {
      const v = r.data[rf.name];
      if (typeof v === "string") {
        let set = idsByTarget.get(rf.targetCollection);
        if (!set) {
          set = new Set();
          idsByTarget.set(rf.targetCollection, set);
        }
        set.add(v);
      }
    }
  }

  // Fetch + resolve + project each target collection's rows once.
  const expandedById = new Map<string, { raw: Record<string, unknown>; view: Record<string, unknown> }>();
  for (const [targetName, ids] of idsByTarget) {
    const targetColl = await getCollection(projectId, targetName);
    if (!targetColl) continue;
    let targetRows = await db
      .select()
      .from(entries)
      .where(and(inArray(entries.id, [...ids]), eq(entries.collectionId, targetColl.id)));
    // Public mode: a target hidden by ITS publicFilter must not be expanded —
    // otherwise expansion would surface a row a direct GET would not. (The bare
    // {id,label} that resolveRelations still produces is pre-existing behavior.)
    if (mode === "public") {
      const pf = (targetColl.publicFilter as WhereItem[] | null) ?? [];
      if (pf.length > 0) {
        targetRows = targetRows.filter((t) => matchesClauses(targetColl.fields, pf, t.data));
      }
    }
    // Snapshot label values before resolveRefsForRead mutates ref fields in place.
    const rawById = new Map(targetRows.map((t) => [t.id, { ...t.data }]));
    await resolveRefsForRead(projectId, targetColl, targetRows, viewer);
    for (const tr of targetRows) {
      const view = mode === "public" ? toPublicView(targetColl, tr) : { id: tr.id, ...tr.data };
      expandedById.set(tr.id, { raw: rawById.get(tr.id)!, view });
    }
  }

  for (const rf of expandFields) {
    for (const r of rows) {
      const v = r.data[rf.name];
      if (typeof v === "string" && expandedById.has(v)) {
        const e = expandedById.get(v)!;
        r.data[rf.name] = { id: v, label: String(e.raw[rf.labelField] ?? v), data: e.view };
      }
    }
  }
  return rows;
}

export interface ReverseSpec {
  /** Child collection that references the parent. */
  collection: string;
  /** Relation field on the child pointing back at the parent. */
  field: string;
  limit?: number;
}

export interface ReverseGroup {
  /** full mode: {id, data}; public mode: the child's toPublicView projection. */
  entries: Record<string, unknown>[];
  hasMore: boolean;
}

/**
 * Reverse relations: for each parent, fetch the children that point at it via a
 * child relation field — the inverse of expand. Capped per parent with an exact
 * hasMore (a windowed row_number query, so a parent with 10k children still only
 * scans limit+1 rows each). Returns a map parentId -> { "collection.field":
 * {entries, hasMore} } that the caller attaches as a `related` SIBLING key
 * (never inside data). Children are read from `entries` only (no trash leak);
 * public mode applies the child's publicFilter + toPublicView.
 */
export async function includeReverse(
  projectId: string,
  parentCollection: Collection,
  parentIds: string[],
  specs: ReverseSpec[],
  mode: "full" | "public",
  viewer?: ReadViewer,
): Promise<Map<string, Record<string, ReverseGroup>>> {
  const out = new Map<string, Record<string, ReverseGroup>>();
  if (specs.length === 0 || parentIds.length === 0) return out;
  if (specs.length > 3) throw new ValidationError("includeReverse: at most 3 specs");

  const idArray = sql`ARRAY[${sql.join(parentIds.map((id) => sql`${id}`), sql`, `)}]::text[]`;

  for (const spec of specs) {
    const child = await getCollection(projectId, spec.collection);
    if (!child) throw new ValidationError(`includeReverse: collection "${spec.collection}" not found`, "E_NOT_FOUND");
    const relField = child.fields.find(
      (f) => f.name === spec.field && f.type === "relation" && f.targetCollection === parentCollection.name,
    );
    if (!relField) {
      const valid = child.fields
        .filter((f) => f.type === "relation" && f.targetCollection === parentCollection.name)
        .map((f) => f.name);
      throw new ValidationError(
        `includeReverse: "${spec.collection}.${spec.field}" must be a relation field on "${spec.collection}" targeting "${parentCollection.name}" — valid: ${valid.join(", ") || "(none)"}`,
      );
    }
    // Defense in depth: on the delivery surface, grouping children by a private
    // back-reference field would disclose its value — refuse it here too.
    if (mode === "public" && relField.publicRead !== true) {
      throw new ValidationError(
        `includeReverse: "${spec.collection}.${spec.field}" is not public — a private back-reference cannot be embedded`,
      );
    }
    const limit = Math.min(Math.max(spec.limit ?? 20, 1), 100);

    // Public mode (delivery): the child's own publicFilter row visibility is
    // ANDed into the fetch — a child a direct GET would hide never embeds.
    const gate =
      mode === "public"
        ? buildWhere(child.fields, (child.publicFilter as WhereItem[] | null) ?? [])
        : [];
    const gateSql = gate.length > 0 ? sql` AND ${and(...gate)}` : sql``;

    // One windowed statement: rank each child within its parent, keep limit+1.
    const result = await db.execute(sql`
      SELECT id, data, parent_ref FROM (
        SELECT id, data, data->>${spec.field} AS parent_ref,
          row_number() OVER (
            PARTITION BY data->>${spec.field}
            ORDER BY date_trunc('milliseconds', created_at), id
          ) AS rn
        FROM ${entries}
        WHERE collection_id = ${child.id} AND data->>${spec.field} = ANY(${idArray})${gateSql}
      ) t
      WHERE rn <= ${limit + 1}
    `);
    const rows = ((result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])) as {
      id: string;
      data: Record<string, unknown>;
      parent_ref: string;
    }[];

    const byParent = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byParent.get(r.parent_ref) ?? [];
      list.push(r);
      byParent.set(r.parent_ref, list);
    }

    // Resolve child refs once for the whole spec, then project per mode.
    const kept = [...byParent.values()].flatMap((list) => list.slice(0, limit));
    const childEntries = kept.map((r) => ({ id: r.id, data: r.data }) as Entry);
    await resolveRefsForRead(projectId, child, childEntries, viewer);
    const viewById = new Map<string, Record<string, unknown>>(
      childEntries.map((e) => [e.id, mode === "public" ? toPublicView(child, e) : { id: e.id, data: e.data }]),
    );

    const key = `${spec.collection}.${spec.field}`;
    for (const [parentId, list] of byParent) {
      const rel = out.get(parentId) ?? {};
      rel[key] = {
        entries: list.slice(0, limit).map((r) => viewById.get(r.id)!),
        hasMore: list.length > limit,
      };
      out.set(parentId, rel);
    }
  }
  return out;
}

/** Project an entry's data down to only fields flagged publicRead. */
export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";
export interface AggregateSpec {
  fn: AggregateFn;
  field?: string;
}

export const MAX_AGGREGATE_GROUPS = 500;

export interface AggregateResult {
  /** One entry per group; a single group with key null when groupBy is absent. */
  groups: { key: string | null; label?: string; values: (number | null)[] }[];
  /** True when more than MAX_AGGREGATE_GROUPS groups exist (largest kept). */
  truncated: boolean;
}

/**
 * Aggregations without fetching rows: count/sum/avg/min/max over number
 * fields, optionally grouped by an enum or relation field (relation group
 * keys resolve to their target's labelField). Same validated where
 * vocabulary as queries; same "reject with a fix hint" discipline.
 */
export async function aggregateEntries(
  collection: Collection,
  opts: { aggregates: AggregateSpec[]; groupBy?: string; where?: WhereItem[]; related?: RelatedContextMap },
): Promise<AggregateResult> {
  const numberFields = collection.fields.filter((f) => f.type === "number");
  const selects: Record<string, ReturnType<typeof sql>> = {};
  opts.aggregates.forEach((spec, i) => {
    if (spec.fn === "count") {
      if (spec.field !== undefined) {
        throw new ValidationError('aggregates: "count" counts rows — omit field');
      }
      selects[`a${i}`] = sql`count(*)`;
      return;
    }
    if (!spec.field) {
      throw new ValidationError(`aggregates: "${spec.fn}" needs a field`);
    }
    const f = collection.fields.find((x) => x.name === spec.field);
    if (!f || f.type !== "number") {
      throw new ValidationError(
        `aggregates: "${spec.fn}" needs a number field — number fields: ${
          numberFields.map((x) => x.name).join(", ") || "(none)"
        }`,
      );
    }
    // fn is enum-validated above, so sql.raw is safe.
    selects[`a${i}`] = sql`${sql.raw(spec.fn)}(${accessor(f)})`;
  });

  const conditions = [
    eq(entries.collectionId, collection.id),
    ...buildWhere(collection.fields, opts.where ?? [], opts.related),
  ];

  const toValues = (row: Record<string, unknown>) =>
    opts.aggregates.map((_, i) => (row[`a${i}`] === null ? null : Number(row[`a${i}`])));

  if (!opts.groupBy) {
    const [row] = await db.select(selects).from(entries).where(and(...conditions));
    return { groups: [{ key: null, values: toValues(row) }], truncated: false };
  }

  const groupField = collection.fields.find((f) => f.name === opts.groupBy);
  if (!groupField || (groupField.type !== "enum" && groupField.type !== "relation")) {
    const groupable = collection.fields
      .filter((f) => f.type === "enum" || f.type === "relation")
      .map((f) => f.name);
    throw new ValidationError(
      `groupBy: needs an enum or relation field — groupable: ${groupable.join(", ") || "(none)"}`,
    );
  }

  // Group/order by ordinal: repeating the parametrized JSONB expression would
  // get fresh parameter numbers and Postgres would refuse to match them.
  const keyExpr = sql`${entries.data}->>${groupField.name}`;
  const rows = await db
    .select({ key: keyExpr, ...selects })
    .from(entries)
    .where(and(...conditions))
    .groupBy(sql`1`)
    .orderBy(sql`count(*) DESC`, sql`1`)
    .limit(MAX_AGGREGATE_GROUPS + 1);

  const truncated = rows.length > MAX_AGGREGATE_GROUPS;
  const groups: AggregateResult["groups"] = rows.slice(0, MAX_AGGREGATE_GROUPS).map((row) => ({
    key: row.key === null ? null : String(row.key),
    values: toValues(row),
  }));

  // Relation group keys are target-entry ids; resolve their labels in one query.
  if (groupField.type === "relation") {
    const ids = groups.map((g) => g.key).filter((k): k is string => k !== null);
    if (ids.length > 0) {
      const [target] = await db
        .select()
        .from(collections)
        .where(
          and(
            eq(collections.projectId, collection.projectId),
            eq(collections.name, groupField.targetCollection),
          ),
        )
        .limit(1);
      if (target) {
        const labelRows = await db
          .select({ id: entries.id, label: sql`${entries.data}->>${groupField.labelField}` })
          .from(entries)
          .where(and(eq(entries.collectionId, target.id), inArray(entries.id, ids)));
        const labels = new Map(labelRows.map((r) => [r.id, r.label === null ? "" : String(r.label)]));
        for (const g of groups) {
          if (g.key !== null && labels.has(g.key)) g.label = labels.get(g.key);
        }
      }
    }
  }

  return { groups, truncated };
}

/** Validate a select list against a collection's fields. Throws with the field list. */
export function validateSelect(fields: FieldDef[], select: string[]): void {
  if (select.length === 0) {
    throw new ValidationError("select: needs at least one field name");
  }
  const valid = new Set(fields.map((f) => f.name));
  for (const name of select) {
    if (!valid.has(name)) {
      throw new ValidationError(
        `select: unknown field "${name}" — valid fields: ${fields.map((f) => f.name).join(", ")}`,
      );
    }
  }
}

/** Project entry data down to the selected fields (validation is the caller's job). */
export function projectData(
  data: Record<string, unknown>,
  select: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of select) if (name in data) out[name] = data[name];
  return out;
}

export function toPublicView(collection: Collection, entry: Entry): Record<string, unknown> {
  const out: Record<string, unknown> = { id: entry.id };
  for (const f of collection.fields) {
    if (f.publicRead && f.name in entry.data) out[f.name] = entry.data[f.name];
  }
  return out;
}

/** The public-read fields of a collection (empty => not exposed at all). */
export function publicFields(collection: Collection): FieldDef[] {
  return collection.fields.filter((f) => f.publicRead);
}
