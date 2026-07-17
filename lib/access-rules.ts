import { z } from "zod";
import type { Collection, ClaimRule, ReadPreset } from "@/db/schema";
import { verifyEndUser, type EndUser } from "./user-auth";
import type { WhereClause, WhereItem } from "./query";
import type { FieldDef, ArrayItem } from "./field-types";

/** The single zod for the access JSONB — shared by define_collection + manifest. */
const claimRuleSchema = z
  .object({ claim: z.string().min(1), equals: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) })
  .strict();
const readPresetSchema = z.union([z.enum(["public", "authenticated", "owner"]), claimRuleSchema]);
const writePresetSchema = z.union([z.enum(["none", "authenticated", "owner"]), claimRuleSchema]);
export const accessSchema = z
  .object({
    read: z.union([readPresetSchema, z.array(readPresetSchema).min(1)]).optional(),
    write: z.union([writePresetSchema, z.array(writePresetSchema).min(1)]).optional(),
    ownerField: z.string().optional(),
    org: z.object({ claim: z.string().min(1), field: z.string() }).strict().optional(),
  })
  .strict();

/**
 * The delivery API's identity gate — parameterized presets, no expression
 * language:
 *
 *   read:  public (default) | authenticated | owner | {claim, equals} | any-of[]
 *   write: none (default — publicWrite governs anonymous forms)
 *          | authenticated (signed-in may CREATE; ownerField stamped)
 *          | owner (create + UPDATE/DELETE of own rows)
 *          | {claim, equals} (staff write: create + mutate ANY row)
 *          | any-of[]
 *
 * A ClaimRule matches when a verified JWT custom claim equals one of the given
 * values (fail-closed: absent/non-string claims never match). An array means
 * any-of. `owner` rows match via ownerField (JWT sub). publicRead still controls
 * the field projection when the row gate passes.
 */

export type Gate =
  | { ok: true; user: EndUser | null; rowClauses?: WhereClause[] }
  | { ok: false; status: number; error: string };

function denied(status: number, error: string): Gate {
  return { ok: false, status, error };
}

/** Fail-closed 403 when an org-scoped collection's user lacks a string org claim. */
function orgDenied(claim: string): Gate {
  return denied(
    403,
    `token has no "${claim}" claim — the user needs an active organization, or add the claim to the Clerk session token template (a nested/object claim must be lifted to a flat string)`,
  );
}

/** The org claim value if present as a non-empty string, else null (fail-closed). */
export function orgClaimValue(user: EndUser, claim: string): string | null {
  const v = user.claims[claim];
  return typeof v === "string" && v !== "" ? v : null;
}

const toList = <T>(rule: T | T[]): T[] => (Array.isArray(rule) ? rule : [rule]);

function isClaimRule(p: unknown): p is ClaimRule {
  return typeof p === "object" && p !== null && "claim" in p && "equals" in p;
}

/** Fail-closed claim match: a JWT claim value (string or string[]) intersecting `equals`. */
export function claimMatches(user: EndUser, rule: ClaimRule): boolean {
  const raw = user.claims[rule.claim];
  const actual =
    typeof raw === "string"
      ? [raw]
      : Array.isArray(raw) && raw.every((x) => typeof x === "string")
        ? (raw as string[])
        : []; // absent / object / number — never coerce
  if (actual.length === 0) return false;
  const expected = Array.isArray(rule.equals) ? rule.equals : [rule.equals];
  return actual.some((a) => expected.includes(a));
}

/** A helpful 403 distinguishing an absent claim from a wrong value (one shape). */
function claimDenied(user: EndUser, rule: ClaimRule): Gate {
  const raw = user.claims[rule.claim];
  const hasStr = typeof raw === "string" || (Array.isArray(raw) && raw.every((x) => typeof x === "string"));
  const want = Array.isArray(rule.equals) ? rule.equals.join('" or "') : rule.equals;
  const detail = hasStr ? `has ${rule.claim}=${JSON.stringify(raw)}` : `has no string "${rule.claim}" claim`;
  return denied(
    403,
    `requires claim "${rule.claim}"="${want}" — the user's JWT ${detail}; add it via the Clerk session token template or user metadata`,
  );
}

/** Deny an authenticated user who met no preset — precise message for a lone claim rule. */
function accessDenied(presets: (string | ClaimRule)[], user: EndUser): Gate {
  const claim = presets.find(isClaimRule);
  if (claim && presets.filter((p) => !isClaimRule(p)).every((p) => p === "owner")) {
    return claimDenied(user, claim);
  }
  return denied(403, "you do not meet this collection's access rule");
}

type RequireUser = { ok: false; gate: Gate } | { ok: true; user: EndUser };

async function requireUser(
  projectId: string,
  collection: Collection,
  userToken: string | null,
): Promise<RequireUser> {
  const auth = await verifyEndUser(projectId, userToken);
  if (auth.status === "unconfigured") {
    return { ok: false, gate: denied(503, "this project has no auth issuer connected (Clerk connector)") };
  }
  if (auth.status === "none") {
    return { ok: false, gate: denied(401, "sign-in required: pass the user's JWT in the X-User-Token header") };
  }
  if (auth.status === "invalid") {
    return { ok: false, gate: denied(401, `invalid user token: ${auth.reason}`) };
  }
  return { ok: true, user: auth.user };
}

/** The read-gate inputs, decoupled from a live Collection so it can be
 *  evaluated against a stored snapshot (change feed: write-time `vis` OR current
 *  access). */
export interface ReadSpec {
  read?: ReadPreset;
  ownerField?: string;
  org?: { claim: string; field: string };
}

/**
 * Does `user` pass `spec`'s READ gate for ONE entry snapshot? Mirrors gateRead's
 * identity logic but per-snapshot (the change feed applies it to stored data for
 * both the write-time and current visibility of its then-AND-now intersection).
 * Fail-closed: org requires a matching claim on the snapshot; authenticated/
 * owner/claim require a verified user.
 */
export function snapshotReadable(
  spec: ReadSpec,
  snapshot: Record<string, unknown>,
  user: EndUser | null,
): boolean {
  const org = spec.org;
  if (org) {
    if (!user) return false;
    const orgVal = orgClaimValue(user, org.claim);
    if (orgVal === null || snapshot[org.field] !== orgVal) return false;
  }
  const presets = toList(spec.read ?? "public");
  if (presets.includes("public")) return true; // org (if any) already enforced
  if (!user) return false;
  if (presets.some((p) => p === "authenticated" || (isClaimRule(p) && claimMatches(user, p)))) return true;
  if (presets.includes("owner")) return !!spec.ownerField && snapshot[spec.ownerField] === user.id;
  return false;
}

export async function gateRead(
  projectId: string,
  collection: Collection,
  userToken: string | null,
): Promise<Gate> {
  const presets = toList(collection.access?.read ?? "public");
  const org = collection.access?.org;
  // Anonymous public read only when there's no org scope (org needs a claim).
  if (presets.includes("public") && !org) return { ok: true, user: null };

  const auth = await requireUser(projectId, collection, userToken);
  if (!auth.ok) return auth.gate;
  const user = auth.user;

  // Org row scope applies to EVERY identity, fail-closed, before any preset.
  const rowClauses: WhereClause[] = [];
  if (org) {
    const orgVal = orgClaimValue(user, org.claim);
    if (orgVal === null) return orgDenied(org.claim);
    rowClauses.push({ field: org.field, op: "eq", value: orgVal });
  }

  // public (only reachable with org, since define-time bars public+org otherwise)
  // or any passing non-owner preset → full read within the org scope.
  if (presets.includes("public")) return { ok: true, user, rowClauses };
  const passedNonOwner = presets.some(
    (p) => p === "authenticated" || (isClaimRule(p) && claimMatches(user, p)),
  );
  if (passedNonOwner) return { ok: true, user, rowClauses };
  if (presets.includes("owner")) {
    const ownerField = collection.access?.ownerField;
    if (!ownerField) return denied(500, "collection misconfigured: owner rule without ownerField");
    rowClauses.push({ field: ownerField, op: "eq", value: user.id });
    return { ok: true, user, rowClauses };
  }
  return accessDenied(presets, user);
}

export async function gateCreate(
  projectId: string,
  collection: Collection,
  userToken: string | null,
): Promise<Gate> {
  const presets = toList(collection.access?.write ?? "none");
  const org = collection.access?.org;

  // Pure `none` with no org: anonymous forms via publicWrite. (Define-time bars
  // org + anonymous write, so an org-scoped collection never reaches here.)
  if (presets.length === 1 && presets[0] === "none" && !org) {
    if (collection.publicWrite) return { ok: true, user: null };
    return denied(403, "public write is not enabled for this collection");
  }

  const auth = await requireUser(projectId, collection, userToken);
  if (!auth.ok) return auth.gate;
  const user = auth.user;

  // Org precondition (fail-closed) — also 403s any residual anonymous create path.
  if (org && orgClaimValue(user, org.claim) === null) return orgDenied(org.claim);

  // authenticated/owner both mean "any signed-in may CREATE"; a claim rule
  // restricts create to matching users.
  const passed = presets.some(
    (p) => p === "authenticated" || p === "owner" || (isClaimRule(p) && claimMatches(user, p)),
  );
  if (passed) return { ok: true, user };
  return accessDenied(presets, user);
}

/** update/delete: allowed under write:"owner" (own rows) or a matching claim rule (any row). */
export async function gateMutate(
  projectId: string,
  collection: Collection,
  userToken: string | null,
  entryData: Record<string, unknown>,
): Promise<Gate> {
  const presets = toList(collection.access?.write ?? "none");
  const hasOwner = presets.includes("owner");
  const claimRules = presets.filter(isClaimRule);
  if (!hasOwner && claimRules.length === 0) {
    return denied(403, 'entry mutation via delivery API requires write: "owner" or a claim rule');
  }

  const gate = await gateCreate(projectId, collection, userToken);
  if (!gate.ok) return gate;
  const user = gate.user!;

  // Org row check first: the row must belong to the user's org (else 404).
  const org = collection.access?.org;
  if (org) {
    const orgVal = orgClaimValue(user, org.claim);
    if (orgVal === null) return orgDenied(org.claim); // (gateCreate already checked, but keep tight)
    if (entryData[org.field] !== orgVal) return denied(404, "not found");
  }

  // A matching claim rule = staff write: mutate ANY row (within the org scope).
  if (claimRules.some((r) => claimMatches(user, r))) return gate;
  // Otherwise owner-scoped: only own rows.
  if (hasOwner) {
    const ownerField = collection.access?.ownerField;
    if (!ownerField) return denied(500, "collection misconfigured: owner rule without ownerField");
    if (entryData[ownerField] === user.id) return gate;
  }
  // 404 not 403: don't confirm the row exists to non-owners.
  return denied(404, "not found");
}

/**
 * Server-set identity fields on create: ownerField ← JWT sub, org.field ← the
 * org claim. Client-supplied values are always overwritten (the gates guarantee
 * the claim exists), so a user can never forge ownership or inject another org.
 *
 * On the ANONYMOUS path (publicWrite, user === null) there is no verified
 * identity to attribute, so the stamped fields are STRIPPED rather than left
 * as-is — otherwise a client could POST {owner:"victim"} and inject a row into
 * the victim's owner-scoped view (the org twin of this is barred at define time;
 * this closes both twins at runtime, defense-in-depth).
 */
export function stampIdentity(
  collection: Collection,
  user: EndUser | null,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...data };
  const ownerField = collection.access?.ownerField;
  const org = collection.access?.org;
  if (!user) {
    if (ownerField) delete out[ownerField];
    if (org) delete out[org.field];
    return out;
  }
  if (ownerField) out[ownerField] = user.id;
  if (org) {
    const orgVal = orgClaimValue(user, org.claim);
    if (orgVal !== null) out[org.field] = orgVal;
  }
  return out;
}

/** The fields stamped from verified identity — stripped from delivery PATCH bodies. */
export function stampedIdentityFields(collection: Collection): string[] {
  const out: string[] = [];
  if (collection.access?.ownerField) out.push(collection.access.ownerField);
  if (collection.access?.org) out.push(collection.access.org.field);
  return out;
}

/** Field names referenced by a collection's publicFilter (flattening anyOf). */
function publicFilterFields(collection: Collection): Set<string> {
  const out = new Set<string>();
  const visit = (c: WhereClause) => {
    if (c && typeof c === "object" && typeof c.field === "string") out.add(c.field);
  };
  for (const item of (collection.publicFilter as WhereItem[] | null) ?? []) {
    if (item && typeof item === "object" && "anyOf" in item && Array.isArray(item.anyOf)) {
      item.anyOf.forEach(visit);
    } else {
      visit(item as WhereClause);
    }
  }
  return out;
}

/**
 * Field-level write gates on the DELIVERY surface. Returns the names of any
 * fields in the payload the caller isn't allowed to write. Server-stamped
 * identity fields are exempt (they're stripped/set separately).
 *
 * Layers:
 *  - F2 invariant: a field that gates public visibility (referenced by the
 *    collection's publicFilter) is NEVER anonymously writable. This closes the
 *    demonstrated mass-assignment exploit — a public form set {approved:true} on
 *    the very flag publicFilter keys on, self-approving its own row. Workflow
 *    state (applyWorkflowOnCreate) and owner/org (stampIdentity) are already
 *    locked on the anonymous path; this adds the visibility-gate twin. To lock
 *    any other field against public writes, set `writableBy:"none"`.
 *  - F4: `writableBy` "none" is barred entirely; a claim rule needs a matching
 *    verified user.
 */
export function checkFieldWrites(
  collection: Collection,
  user: EndUser | null,
  payload: Record<string, unknown>,
): string[] {
  const exempt = new Set(stampedIdentityFields(collection));
  const gateFields = user === null ? publicFilterFields(collection) : null;
  const offending: string[] = [];
  for (const f of collection.fields) {
    if (exempt.has(f.name) || !(f.name in payload)) continue;
    // F2 invariant: visibility-gating fields are never anonymously writable.
    if (user === null && gateFields!.has(f.name)) {
      offending.push(f.name);
      continue;
    }
    // F4: explicit per-field write gate (applies to any caller).
    if (f.writableBy) {
      const allowed =
        f.writableBy === "none"
          ? false
          : user !== null && claimMatches(user, f.writableBy);
      if (!allowed) {
        offending.push(f.name);
        continue;
      }
    }
    // Nested write-gate (F2 for structured fields): a `writableBy` sub-field
    // buried in a group/array must be honored too, or a nested moderation flag
    // is mass-assignable. publicFilter is top-level only, so only writableBy
    // recurses here.
    if (f.type === "group" || f.type === "array") {
      collectNestedWriteViolations(f, payload[f.name], user, f.name, offending);
    }
  }
  return offending;
}

function nestedWriteAllowed(
  writableBy: NonNullable<FieldDef["writableBy"]>,
  user: EndUser | null,
): boolean {
  return writableBy === "none" ? false : user !== null && claimMatches(user, writableBy);
}

function collectNestedWriteViolations(
  spec: FieldDef | ArrayItem,
  value: unknown,
  user: EndUser | null,
  path: string,
  offending: string[],
): void {
  if (spec.type === "group") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const src = value as Record<string, unknown>;
    for (const sub of spec.fields) {
      if (!(sub.name in src)) continue;
      const p = `${path}.${sub.name}`;
      if (sub.writableBy && !nestedWriteAllowed(sub.writableBy, user)) {
        offending.push(p);
        continue;
      }
      collectNestedWriteViolations(sub, src[sub.name], user, p, offending);
    }
  } else if (spec.type === "array") {
    if (!Array.isArray(value)) return;
    value.forEach((el, i) => {
      // Typed blocks: gate through the block matching the element's own
      // `_type`. A mismatched/unknown _type has no declared fields to gate —
      // the strict discriminated-union validation rejects it right after, so
      // nothing writable slips through the gap (F2 holds per block).
      let item: FieldDef | ArrayItem | undefined = spec.item;
      if (spec.blocks) {
        const t = el && typeof el === "object" && !Array.isArray(el) ? (el as Record<string, unknown>)._type : undefined;
        const block = typeof t === "string" ? spec.blocks.find((b) => b.name === t) : undefined;
        item = block ? ({ type: "group", fields: block.fields } as ArrayItem) : undefined;
      }
      if (item) collectNestedWriteViolations(item, el, user, `${path}[${i}]`, offending);
    });
  }
}
