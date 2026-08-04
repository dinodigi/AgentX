import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import { unstable_cache, revalidateTag } from "next/cache";
import { db } from "@/db";
import { assertCollectionCap } from "./caps";
import { tenantDb } from "./data-plane";
import type { DbExecutor } from "./db-tx";
import { collections, entries, entriesTrash, entryVersions, projects, type Collection, type EventAction, type WriteHook } from "@/db/schema";
import { getConnector, hasProvider } from "./connectors";
import { parseAfter, senderRefusal } from "./events";
import { validateWorkflow } from "./workflow";
import { recordChangesStrict } from "./changes";
import { ValidationError } from "./validation";
import { getBlockLibrary, resolveLibraryBlocks } from "./blocks";
import { validateFieldDefs, collectionNameSchema } from "./validation";
import { buildWhere, type WhereItem } from "./query";
import { fieldMin, fieldMax, fieldPattern, fieldInteger, fieldLocalized, fieldWriteOnly, type FieldDef } from "./field-types";
import { getLocales } from "./locales";
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
    // TTL: revalidateTag is per-instance — with N app instances the other N-1
    // converge via this window (found live: a confirmed retype looked unapplied
    // because the OTHER instance kept serving the old schema indefinitely).
    { tags: [collectionsTag(projectId)], revalidate: 15 },
  );
  return (await cached()).map(revive);
}

/**
 * Collection NAMES, read FRESH — never through the cache.
 *
 * Standing rule (destructive-change gate, relation-target validation are the
 * precedents): anything a correctness decision hangs on reads from the DB, not
 * from a 15s window that another instance may still be serving stale. PLUG-3's
 * applied-state is such a decision — a stale "that collection isn't here" would
 * push an agent to re-apply a baseline that IS here, straight into the
 * destructive-change gate. Names only, so it stays one cheap indexed read.
 */
export async function listCollectionNamesFresh(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ name: collections.name })
    .from(collections)
    .where(eq(collections.projectId, projectId));
  return rows.map((r) => r.name);
}

/**
 * FRESH full-row reads for the MCP AUTHORING surface (friction sprint, Track A).
 *
 * Agents act within seconds of their own mutations, and the 15s cross-instance
 * cache window has now produced its sixth and seventh field reports (Codex
 * 2026-07-23: "deletion reports success but the collection remains visible",
 * "searchable:true not picked up after redefine" — both converge in <1s
 * single-instance; the reports came from the multi-instance window). On the
 * authoring surface, read-your-own-writes is CORRECTNESS, not a nicety — a
 * stale read walks an agent into re-applying or re-deleting through the
 * destructive-change gate.
 *
 * Delivery and admin keep the cached readers above: human-paced, volume-heavy,
 * and a 15s window is invisible at human speed. Cost here is one indexed
 * control-DB read per MCP call, bounded by the 300/min surface cap.
 */
export async function listCollectionsFresh(projectId: string): Promise<Collection[]> {
  const rows = await db.select().from(collections).where(eq(collections.projectId, projectId));
  return rows.map(revive);
}
// (getCollectionFresh already exists below — added for the delivery deny-path
// re-check, an earlier sighting of the same staleness class. A1 reuses it.)

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
    { tags: [collectionsTag(projectId)], revalidate: 15 },
  );
  const rows = await cached();
  return rows[0] ? revive(rows[0]) : null;
}

/**
 * Uncached fetch — the fresh-on-deny half of the gate rule ("a correctness
 * gate must never deny on a cached read"). Wall report (Fatsoz): an operator
 * RELAXED access rules and the delivery gate kept refusing anonymous
 * submissions off the stale cached collection for up to a TTL. Deny paths
 * re-check against this before answering; hot allow paths stay cached.
 */
export async function getCollectionFresh(
  projectId: string,
  name: string,
): Promise<Collection | null> {
  const rows = await db
    .select()
    .from(collections)
    .where(and(eq(collections.projectId, projectId), eq(collections.name, name)))
    .limit(1);
  return rows[0] ? revive(rows[0]) : null;
}

/** The optimistic-concurrency guard fired: re-read and retry. */
export class SchemaConflictError extends Error {
  constructor(public readonly collection: string) {
    super(`"${collection}" changed concurrently — re-read and retry`);
    this.name = "SchemaConflictError";
  }
}

export interface DefineCollectionInput {
  name: string;
  displayName?: string;
  fields: FieldDef[];
  /**
   * Optimistic-concurrency guard. When set, the write applies ONLY if the
   * collection's `updatedAt` still equals this value; otherwise it throws
   * SchemaConflictError and nothing is written.
   *
   * Exists for the additive-field path, where a plain read-modify-write loses
   * a concurrent adder's field: two callers read the same list, each appends
   * its own, and the second write erases the first while BOTH report success.
   * Verify-and-retry does not rescue it either — each racer can verify before
   * the other's write lands, see its own field, and stop.
   */
  expectUpdatedAt?: Date;
  publicWrite?: boolean;
  webhookUrl?: string | null;
  /**
   * Row visibility for delivery reads: only rows matching ALL clauses are
   * publicly served (e.g. [{field:"approved",op:"eq",value:true}]). May
   * reference private fields. Admin/MCP reads are unaffected.
   */
  publicFilter?: WhereItem[] | null;
  /** Identity rule presets (Phase 4/12). owner rules need ownerField; claim rules
   *  and any-of arrays and org scoping are the higher rungs. */
  access?: Collection["access"] | null;
  /** Declarative event actions (Phase 3). Email needs an email provider connected. */
  events?: {
    created?: EventAction[];
    updated?: EventAction[];
    deleted?: EventAction[];
  } | null;
  /**
   * Declared field renames: data is backfilled (old key moved to the new key),
   * so a rename never strands entries the way drop+add would. Types must match.
   */
  /**
   * `{from, to}` renames a FIELD. `{field, from, to}` renames one ENUM OPTION
   * inside that field — the option-level migration that did not exist, which
   * meant changing an option silently orphaned every row still holding the old
   * value: the row keeps a value the enum no longer permits, so it fails
   * validation on the next save and no longer matches a filter on either name.
   */
  renames?: { from: string; to: string; field?: string }[];
  /** G4: a state machine over one enum field — initial enforced on create,
   * actor-gated transitions the only way it moves. */
  workflow?: Collection["workflow"] | null;
  /** K2a: declarative Stripe checkout (priceField + success/cancel URLs). */
  checkout?: Collection["checkout"] | null;
  /** I1: signed before-write hooks to BYO compute (I1a: beforeCreate/validate). */
  hooks?: Collection["hooks"] | null;
  /** Required when redefinition drops or retypes fields (destructive). */
  confirm?: boolean;
  /** DX-7: validate + return the FULL plan (diff, warnings, notes); apply NOTHING. */
  dryRun?: boolean;
}

const READ_RULES = ["public", "authenticated", "owner"] as const;
const WRITE_RULES = ["none", "authenticated", "owner"] as const;

/**
 * J5: interpolate() renders {{field}} tokens with String(value) — a localized
 * variant map would put "[object Object]" (or raw JSON) into an email header or
 * body. Rejected at define time with the fix named; interpolate stays untouched.
 * Only LOCALIZED references are rejected — unknown-field references keep their
 * pre-existing (silent) behavior, deliberately not tightened here.
 */
function assertNoLocalizedTemplateRefs(
  fields: FieldDef[],
  action: { to?: string; subject?: string; body?: string; html?: string },
  context: string,
): void {
  for (const [part, source] of Object.entries({ to: action.to, subject: action.subject, body: action.body, html: action.html })) {
    if (!source) continue;
    for (const m of source.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi)) {
      const rf = fields.find((x) => x.name === m[1]);
      if (rf && fieldLocalized(rf)) {
        throw new ValidationError(
          `${context}: email ${part} references localized field "{{${m[1]}}}" — templates render one raw value; reference a non-localized field`,
        );
      }
      // SEC-1: an email is a read path with a recipient. `{{password_hash}}` in a
      // subject or body would mail the credential (and store it in the delivery
      // log), and interpolate() renders from redacted data anyway — so the token
      // would silently render as "". Refuse at define rather than send blanks.
      if (rf && fieldWriteOnly(rf)) {
        throw new ValidationError(
          `${context}: email ${part} references write-only field "{{${m[1]}}}" — a write-only value is never read, so it can never be emailed or logged; reference a readable field`,
        );
      }
    }
  }
}

async function validateAccessAndEvents(
  projectId: string,
  fields: FieldDef[],
  access: DefineCollectionInput["access"],
  events: DefineCollectionInput["events"],
  publicWrite: boolean,
): Promise<void> {
  if (access) {
    const arr = <T>(v: T | T[] | undefined, dflt: T): T[] => (v === undefined ? [dflt] : Array.isArray(v) ? v : [v]);
    const readList = arr(access.read, "public" as const);
    const writeList = arr(access.write, "none" as const);
    // String presets must be in the allowed set (claim-rule objects pass — the
    // access zod already validated their {claim, equals} shape).
    for (const p of readList) {
      if (typeof p === "string" && !(READ_RULES as readonly string[]).includes(p)) {
        throw new ValidationError(`access.read presets must be one of ${READ_RULES.join("|")} or a {claim, equals} rule`);
      }
    }
    for (const p of writeList) {
      if (typeof p === "string" && !(WRITE_RULES as readonly string[]).includes(p)) {
        throw new ValidationError(`access.write presets must be one of ${WRITE_RULES.join("|")} or a {claim, equals} rule`);
      }
    }
    if (writeList.includes("none") && writeList.length > 1) {
      throw new ValidationError('access.write "none" cannot be combined with other presets');
    }
    // ownerField is required by owner presets (either direction) and by
    // authenticated WRITE (it stamps the owner); claim rules don't need it.
    const needsOwner =
      readList.includes("owner") || writeList.includes("owner") || writeList.includes("authenticated");
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
      if (fieldLocalized(f)) {
        throw new ValidationError(
          `access.ownerField "${access.ownerField}" cannot be localized — it holds one server-stamped user id`,
        );
      }
      // SEC-1: ownership is compared on every gated read and stamped into the
      // change feed's `vis` — it is identity metadata, not a secret.
      if (fieldWriteOnly(f)) {
        throw new ValidationError(
          `access.ownerField "${access.ownerField}" cannot be write-only — every gated read compares it, so it must be readable`,
        );
      }
    }
    // Anonymous write = the only write path is publicWrite with no signed-in
    // create. Such a create has no verified identity, so it can never be
    // attributed to an owner or org — reject the combo at define time rather
    // than silently storing a client-chosen (forgeable) identity value.
    // A5: publicWrite now opens an anonymous create path REGARDLESS of
    // access.write — the two compose rather than replace each other — so this
    // bar must fire whenever publicWrite is on, not only when write is exactly
    // "none". Otherwise publicWrite + write:"owner" would quietly produce
    // owner-LESS rows: stampIdentity strips the field it cannot verify, so they
    // are invisible to owner-scoped reads and unmutatable forever. Not a
    // forgery risk, but a silent data trap, which is what this gate exists to
    // stop. (Checked against live data first — no collection uses the combo.)
    const anonWrite = publicWrite === true;
    if (anonWrite && (readList.includes("owner") || writeList.includes("owner"))) {
      throw new ValidationError(
        'owner-scoped collections cannot accept anonymous writes: an anonymous create cannot be attributed to an owner (the client would control ownerField), so the row would be orphaned — invisible to owner-scoped reads and permanently unmutatable. Either drop publicWrite and use access.write "authenticated"/"owner", or drop the owner scope and gate mutations with a claim rule (publicWrite + a claim write is the anonymous-intake/staff-triage shape)',
      );
    }
    // F3: org row scoping — every row carries the user's org claim, fail-closed.
    if (access.org) {
      const orgField = fields.find((x) => x.name === access.org!.field);
      if (!orgField || orgField.type !== "text") {
        throw new ValidationError(
          `access.org.field "${access.org.field}" must name an existing text field (holds the org id)`,
        );
      }
      if (fieldLocalized(orgField)) {
        throw new ValidationError(
          `access.org.field "${access.org.field}" cannot be localized — it holds one server-stamped org id`,
        );
      }
      if (fieldWriteOnly(orgField)) {
        throw new ValidationError(
          `access.org.field "${access.org.field}" cannot be write-only — row scoping compares it on every read, so it must be readable`,
        );
      }
      if (readList.includes("public")) {
        throw new ValidationError(
          'access.org cannot be combined with read:"public" — public rows can\'t be org-scoped; use read:"authenticated"',
        );
      }
      // No anonymous write into an org-scoped collection — closes org injection.
      if (anonWrite) {
        throw new ValidationError(
          'org-scoped collections cannot accept anonymous writes: set access.write to "authenticated" or "owner" (or a claim rule), or remove access.org/publicWrite',
        );
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
        assertNoLocalizedTemplateRefs(fields, a, "events");
        // 2a: a custom sender must be approved at define time (fromEmail /
        // its domain / approvedSenders) — send-time re-checks and falls back.
        if (a.from) {
          const refusal = await senderRefusal(projectId, a.from);
          if (refusal) throw new ValidationError(`events: ${refusal}`);
        }
      } else {
        throw new ValidationError('events: action type must be "webhook" or "email"');
      }
      // Conditional clauses get the same define-time validation as query where.
      if (a.when?.length) buildWhere(fields, a.when);
      // Delayed actions: `after` must parse and stay within 1m..365d (G2).
      if (a.after !== undefined && parseAfter(a.after) === null) {
        throw new ValidationError(
          `events: after "${a.after}" is invalid — use "<n>m" | "<n>h" | "<n>d" (minutes/hours/days), between "1m" and "365d", e.g. after: "3d"`,
        );
      }
    }
    if (all.some((a) => a.type === "email") && !(await hasProvider(projectId, "email"))) {
      throw new ValidationError(
        "events: email actions need an email provider — connect Resend or Elastic Email in project settings first",
        "E_CONNECTOR_REQUIRED",
      );
    }
  }
}

/**
 * K2a: validate declarative Stripe checkout. priceField must be text; URLs
 * https; the collection must be publicly readable (owner/authenticated
 * collections cannot be sold — with read pinned to public, publicFilter is the
 * complete row gate, so the checkout trust boundary equals a public delivery
 * read); the Stripe connector must be connected. K4 extends this with the
 * `orders` mapping validation.
 */
async function validateCheckout(
  projectId: string,
  checkout: NonNullable<DefineCollectionInput["checkout"]>,
  fields: FieldDef[],
  access: DefineCollectionInput["access"],
): Promise<void> {
  const priceField = fields.find((f) => f.name === checkout.priceField);
  if (!priceField || priceField.type !== "text") {
    throw new ValidationError(
      `checkout.priceField "${checkout.priceField}" must name an existing text field holding a Stripe Price id (price_…)`,
    );
  }
  if (fieldLocalized(priceField)) {
    throw new ValidationError(
      `checkout.priceField "${checkout.priceField}" cannot be localized — a Price id is one value, not a translation`,
    );
  }
  // SEC-1: the checkout route READS this field to build the Stripe session.
  if (fieldWriteOnly(priceField)) {
    throw new ValidationError(
      `checkout.priceField "${checkout.priceField}" cannot be write-only — the checkout route reads it to build the Stripe session`,
    );
  }
  for (const key of ["successUrl", "cancelUrl"] as const) {
    if (!checkout[key] || !/^https:\/\//.test(checkout[key])) {
      throw new ValidationError(`checkout.${key} must be an https URL`);
    }
  }
  // Sellable ⇒ publicly readable. Strictly `public` or absent (not an array/claim/owner).
  const read = access?.read;
  if (read !== undefined && read !== "public") {
    throw new ValidationError(
      'checkout requires access.read: "public" (or absent) — owner/authenticated collections cannot be sold; model member-only pricing in your app layer via events',
    );
  }
  if (!(await getConnector(projectId, "stripe"))) {
    throw new ValidationError(
      "checkout needs the Stripe connector — connect it in project settings first",
      "E_CONNECTOR_REQUIRED",
    );
  }
  if (checkout.orders) await validateCheckoutOrders(projectId, checkout.orders);
}

/**
 * K4: validate the orders mapping — the target collection must exist in THIS
 * project, and each mapped field must exist with the type the webhook writes.
 * status must be an enum whose options cover the three lifecycle states the
 * webhook drives it through. Fix-hints name the exact field/type to add.
 */
type OrdersMapping = NonNullable<NonNullable<DefineCollectionInput["checkout"]>["orders"]>;

async function validateCheckoutOrders(projectId: string, orders: OrdersMapping): Promise<void> {
  const target = await getCollection(projectId, orders.collection);
  if (!target) {
    throw new ValidationError(
      `checkout.orders.collection "${orders.collection}" does not exist — define the orders collection first`,
    );
  }
  assertOrdersMapping(orders, target.fields, orders.collection);
}

/**
 * The pure field-shape checks for an orders mapping, against a SPECIFIC set of
 * target fields. Split out so a redefine of the orders collection itself can be
 * validated against its PROPOSED fields (not the stored ones) — narrowing the
 * status enum or adding a required field out from under live orders is rejected
 * at define time, per invariant #8.
 */
function assertOrdersMapping(orders: OrdersMapping, targetFields: FieldDef[], targetName: string): void {
  const field = (name: string) => targetFields.find((f) => f.name === name);
  const require = (role: string, name: string | undefined): FieldDef => {
    if (!name) throw new ValidationError(`checkout.orders.fields.${role} is required`);
    const f = field(name);
    if (!f) {
      throw new ValidationError(
        `checkout.orders.fields.${role} names "${name}", which is not a field on "${targetName}"`,
      );
    }
    return f;
  };

  const status = require("status", orders.fields.status);
  if (status.type !== "enum") {
    throw new ValidationError(
      `checkout.orders.fields.status "${status.name}" must be an enum field (with options pending, paid, expired)`,
    );
  }
  const opts = new Set(status.options ?? []);
  const missing = ["pending", "paid", "expired"].filter((s) => !opts.has(s));
  if (missing.length) {
    throw new ValidationError(
      `checkout.orders.fields.status enum "${status.name}" is missing required option(s): ${missing.join(", ")} — the order lifecycle needs pending, paid, expired`,
    );
  }

  const sessionId = require("sessionId", orders.fields.sessionId);
  if (sessionId.type !== "text") {
    throw new ValidationError(`checkout.orders.fields.sessionId "${sessionId.name}" must be a text field`);
  }
  // Optional fields — validated only when mapped. Constraints that the
  // server-written value could violate are rejected here, not discovered as a
  // failed order flip weeks later: the webhook writes an arbitrary decimal
  // total from Stripe and a repeat buyer's email more than once.
  let itemsField: FieldDef | undefined;
  if (orders.fields.total !== undefined) {
    const total = require("total", orders.fields.total);
    if (total.type !== "number") {
      throw new ValidationError(`checkout.orders.fields.total "${total.name}" must be a number field`);
    }
    if (fieldInteger(total) || fieldMin(total) !== undefined || fieldMax(total) !== undefined) {
      throw new ValidationError(
        `checkout.orders.fields.total "${total.name}" must not be integer/min/max — Stripe amounts are arbitrary decimals (e.g. 24.99) and a bound would reject real orders`,
      );
    }
  }
  if (orders.fields.customerEmail !== undefined) {
    const email = require("customerEmail", orders.fields.customerEmail);
    if (email.type !== "text") {
      throw new ValidationError(`checkout.orders.fields.customerEmail "${email.name}" must be a text field`);
    }
    if ("unique" in email && email.unique) {
      throw new ValidationError(
        `checkout.orders.fields.customerEmail "${email.name}" must not be unique — a repeat buyer's second order would collide`,
      );
    }
  }
  if (orders.fields.items !== undefined) {
    itemsField = require("items", orders.fields.items);
    if (itemsField.type !== "text" && itemsField.type !== "richtext") {
      throw new ValidationError(`checkout.orders.fields.items "${itemsField.name}" must be a text or richtext field`);
    }
    if (("unique" in itemsField && itemsField.unique) || fieldMax(itemsField) !== undefined || fieldPattern(itemsField)) {
      throw new ValidationError(
        `checkout.orders.fields.items "${itemsField.name}" must not be unique/max/pattern — it holds a cart-JSON snapshot the server writes`,
      );
    }
  }

  // The pending order is written at checkout time with ONLY status (+ items if
  // mapped); everything else arrives on the paid flip. So no OTHER field may be
  // required, or /v1/checkout's createEntry would reject every order.
  const preFilled = new Set([status.name, ...(itemsField ? [itemsField.name] : [])]);
  const blocking = targetFields.find((fld) => fld.required && !preFilled.has(fld.name));
  if (blocking) {
    throw new ValidationError(
      `"${targetName}.${blocking.name}" is required, but a pending order is created before payment with only ${[...preFilled].join(" + ")} — make ${blocking.name} optional`,
    );
  }
}

/**
 * I1a/I1b: validate before-write hook config (beforeCreate + beforeUpdate,
 * validate + transform). Requires the project's webhook signing secret — the
 * consult is HMAC-signed so the tenant endpoint can authenticate AgentX.
 * transform is https-only: it rewrites your data, so the channel must be
 * encrypted (a MITM on http could inject fields / move ownership).
 */
function validateOneHook(stage: string, hook: WriteHook, fields: FieldDef[]): void {
  if (hook.mode !== "validate" && hook.mode !== "transform") {
    throw new ValidationError(`hooks.${stage}.mode must be "validate" or "transform"`);
  }
  let u: URL;
  try {
    u = new URL(hook.url);
  } catch {
    throw new ValidationError(`hooks.${stage}.url must be an absolute http(s) URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ValidationError(`hooks.${stage}.url must use http or https`);
  }
  // transform rewrites your data, so the channel must be encrypted — EXCEPT
  // loopback, which can't be MITM'd (a co-located endpoint may use http localhost).
  // Node's WHATWG URL serializes an IPv6 host WITH brackets ("[::1]"), so match that.
  const loopback =
    u.hostname === "localhost" || u.hostname === "[::1]" || /^127(\.\d+){3}$/.test(u.hostname);
  if (hook.mode === "transform" && u.protocol !== "https:" && !loopback) {
    throw new ValidationError(
      `hooks.${stage}.url must be https for transform mode (loopback excepted) — a transform rewrites your data, so a non-loopback channel must be encrypted`,
    );
  }
  if (hook.onError !== undefined && hook.onError !== "reject" && hook.onError !== "allow") {
    throw new ValidationError(`hooks.${stage}.onError must be "reject" (fail-closed, default) or "allow"`);
  }
  if (
    hook.timeoutMs !== undefined &&
    (typeof hook.timeoutMs !== "number" || hook.timeoutMs < 500 || hook.timeoutMs > 5000)
  ) {
    throw new ValidationError(`hooks.${stage}.timeoutMs must be a number between 500 and 5000`);
  }
  if (hook.when?.length) buildWhere(fields, hook.when); // throws a field-named hint on a bad clause
}

async function validateHooks(
  projectId: string,
  hooks: NonNullable<DefineCollectionInput["hooks"]>,
  fields: FieldDef[],
): Promise<void> {
  // Shape is always validated (so re-enabling later is clean), but the signing
  // secret is only required by an ENABLED hook — a disabled one never runs, so a
  // manifest can import hooks into a secret-less project as disabled (see
  // importProject's downgrade).
  if (hooks.beforeCreate) validateOneHook("beforeCreate", hooks.beforeCreate, fields);
  if (hooks.beforeUpdate) validateOneHook("beforeUpdate", hooks.beforeUpdate, fields);
  const hasEnabled =
    (hooks.beforeCreate && !hooks.beforeCreate.disabled) || (hooks.beforeUpdate && !hooks.beforeUpdate.disabled);
  if (!hasEnabled) return;
  const [proj] = await db
    .select({ secret: projects.webhookSigningSecret })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!proj?.secret) {
    throw new ValidationError(
      "a before-write hook needs the project's webhook signing secret — generate it in project settings first",
    );
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
  /** #11: a redefine that omits `workflow` removes the live state machine. */
  workflowRemoved?: boolean;
  /** MT-4: a redefine that omits `access` removes the identity rules — the same
   * silent-drop shape as workflowRemoved, one subsystem over. Joins the confirm
   * gate, because the failure is INVISIBLE: reads/writes keep succeeding, they
   * just stop being gated, and nothing in the response would have said so. */
  accessRemoved?: { read: boolean; write: boolean; org: boolean };
  /** J8: localizing a populated field — non-destructive wrap under the default
   * locale, applied immediately (rename-backfill precedent). */
  localized?: { field: string; entriesToWrap: number }[];
  /** J8: DE-localizing a populated field drops every non-default variant
   * (entries lacking a default variant lose the field entirely) — destructive,
   * so it joins the confirm gate. */
  delocalized?: {
    field: string;
    entriesAffected: number;
    variantsLost: string[];
    entriesLosingField: number;
  }[];
}

/** Structural diff between an existing definition and a proposed one. */
export function diffFields(
  oldFields: FieldDef[],
  newFields: FieldDef[],
  renames: { from: string; to: string; field?: string }[] = [],
): Omit<SchemaDiff, "affectedEntries"> {
  // Option renames (`field` set) rename a VALUE, not a key — they must not
  // suppress add/remove detection for fields of the same name.
  const fieldRenames = renames.filter((r) => !r.field);
  const renameFroms = new Set(fieldRenames.map((r) => r.from));
  const renameTos = new Set(fieldRenames.map((r) => r.to));
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
  return { added, removed, retyped, renamed: fieldRenames };
}

/** A rename must move an existing field to a same-typed new field, cleanly. */
function validateRenames(
  current: Collection | undefined,
  newFields: FieldDef[],
  renames: { from: string; to: string; field?: string }[],
): void {
  if (renames.length === 0) return;
  if (!current) {
    throw new ValidationError("renames: nothing to rename — this collection doesn't exist yet");
  }
  const seen = new Set<string>();
  for (const r of renames) {
    if (r.field) {
      // ENUM OPTION rename: the field itself must exist on both sides and stay
      // an enum; `from` must be a CURRENT option and `to` a NEW one. Validated
      // strictly, because a typo here rewrites stored values.
      const oldF = current.fields.find((f) => f.name === r.field);
      const newF = newFields.find((f) => f.name === r.field);
      if (!oldF || oldF.type !== "enum") {
        throw new ValidationError(
          `renames: "${r.field}" is not an existing enum field of "${current.name}" — an option rename needs one`,
        );
      }
      if (!newF || newF.type !== "enum") {
        throw new ValidationError(
          `renames: "${r.field}" must still be an enum field in the new definition`,
        );
      }
      if (!(oldF.options ?? []).includes(r.from)) {
        throw new ValidationError(
          `renames: "${r.from}" is not a current option of "${r.field}" — options: ${(oldF.options ?? []).join(", ")}`,
        );
      }
      if (!(newF.options ?? []).includes(r.to)) {
        throw new ValidationError(
          `renames: "${r.to}" must be an option of "${r.field}" in the NEW definition — options: ${(newF.options ?? []).join(", ")}`,
        );
      }
      if ((newF.options ?? []).includes(r.from)) {
        throw new ValidationError(
          `renames: "${r.from}" is still an option of "${r.field}" — remove it from options (its rows move to "${r.to}")`,
        );
      }
      continue;
    }
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
async function countEntriesWithKeys(dbc: DbExecutor, collectionId: string, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const keyList = sql.join(keys.map((k) => sql`${k}`), sql`, `);
  const rows = await dbc
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
  projectId: string,
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

  // Indexes live on the tenant DB's entries table (A1).
  const tdb = await tenantDb(projectId);
  const name = searchIndexName(collectionId);
  await tdb.execute(sql.raw(`DROP INDEX IF EXISTS "${name}"`));
  const subset = publicSearchableFields(newFields);
  if (subset.length > 0) {
    await tdb.execute(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS "${name}" ON entries USING GIN ((${searchVectorText(subset)})) ` +
          `WHERE collection_id = '${collectionId}'`,
      ),
    );
  }
}

/** Per-collection capacity trigger names (same 8-hex-prefix scheme as indexes). */
function capacityFnName(collectionId: string, field: string): string {
  return `entries_cap_${collectionId.replaceAll("-", "").slice(0, 8)}_${field}`.slice(0, 63);
}

/**
 * `capacity: N` — at most N rows may share each value of a field.
 *
 * `unique` already gave exactly-one-per-key; nothing gave AT MOST N, so booking
 * capacity ("10 seats per slot") had to be a count-then-insert in application
 * code. That races: two callers both count 9 and both insert, and the slot
 * oversells. The reporter asked for the constraint precisely because the
 * workaround cannot be made correct from outside the database.
 *
 * So it is a BEFORE INSERT OR UPDATE trigger that takes a per-key advisory lock
 * before counting. The lock serializes only writers touching the SAME key, and
 * it is an xact lock taken inside the same statement as the insert — which is
 * exactly the scope that survives the neon-http driver, where each statement is
 * its own transaction.
 *
 * SQLSTATE 23505 is raised deliberately so this arrives on the same error path
 * as a unique violation, which callers already handle.
 */
async function syncCapacityTriggers(
  projectId: string,
  collectionId: string,
  oldFields: FieldDef[],
  newFields: FieldDef[],
): Promise<void> {
  const caps = (fs: FieldDef[]) =>
    new Map(fs.filter((f) => f.capacity !== undefined).map((f) => [f.name, f.capacity!]));
  const oldCaps = caps(oldFields);
  const newCaps = caps(newFields);
  const tdb = await tenantDb(projectId);

  for (const [name] of oldCaps) {
    if (newCaps.get(name) === oldCaps.get(name)) continue; // unchanged
    const fn = capacityFnName(collectionId, name);
    await tdb.execute(sql.raw(`DROP TRIGGER IF EXISTS "${fn}_trg" ON entries`));
    await tdb.execute(sql.raw(`DROP FUNCTION IF EXISTS "${fn}"()`));
  }
  for (const [name, max] of newCaps) {
    if (oldCaps.get(name) === max) continue; // unchanged
    const fn = capacityFnName(collectionId, name);
    // Names are validated snake_case and the id is a uuid, so raw is safe here.
    await tdb.execute(
      sql.raw(`
        CREATE OR REPLACE FUNCTION "${fn}"() RETURNS trigger AS $fn$
        DECLARE k text; n int;
        BEGIN
          k := NEW.data->>'${name}';
          IF k IS NULL THEN RETURN NEW; END IF;
          IF TG_OP = 'UPDATE' AND OLD.data->>'${name}' IS NOT DISTINCT FROM k THEN
            RETURN NEW;  -- key unchanged: the row already counted toward its own slot
          END IF;
          PERFORM pg_advisory_xact_lock(hashtext('${collectionId}' || k));
          SELECT count(*) INTO n FROM entries
            WHERE collection_id = '${collectionId}' AND data->>'${name}' = k;
          IF n >= ${max} THEN
            RAISE EXCEPTION 'entries_cap_${name}: at most ${max} per "%"', k
              USING ERRCODE = '23505';
          END IF;
          RETURN NEW;
        END $fn$ LANGUAGE plpgsql`),
    );
    await tdb.execute(sql.raw(`DROP TRIGGER IF EXISTS "${fn}_trg" ON entries`));
    await tdb.execute(
      sql.raw(`
        CREATE TRIGGER "${fn}_trg" BEFORE INSERT OR UPDATE ON entries
        FOR EACH ROW WHEN (NEW.collection_id = '${collectionId}')
        EXECUTE FUNCTION "${fn}"()`),
    );
  }
}

async function syncUniqueIndexes(
  projectId: string,
  collectionId: string,
  oldFields: FieldDef[],
  newFields: FieldDef[],
): Promise<void> {
  const oldUnique = new Set(oldFields.filter((f) => f.unique).map((f) => f.name));
  const newUnique = new Set(newFields.filter((f) => f.unique).map((f) => f.name));

  // Indexes + the date-canonicalizing backfill run on the tenant DB's entries (A1).
  const tdb = await tenantDb(projectId);
  for (const name of oldUnique) {
    if (!newUnique.has(name)) {
      await tdb.execute(sql.raw(`DROP INDEX IF EXISTS "${uniqueIndexName(collectionId, name)}"`));
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
        await tdb.execute(sql`
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
      await tdb.execute(
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

function filterIndexName(collectionId: string, field: string): string {
  return `entries_fx_${collectionId.replaceAll("-", "").slice(0, 8)}_${field}`.slice(0, 63);
}

/** The index expression MUST match accessor() in lib/query.ts or the planner
 * ignores it: number/date/boolean index the cast used by filters+sorts; the
 * rest (text/enum/asset/relation) index the raw JSONB text. */
function filterIndexExpr(f: FieldDef): string {
  const raw = `(data->>'${f.name}')`;
  switch (f.type) {
    case "number":
      return `((${raw})::numeric)`;
    case "date":
      // A3: RAW TEXT, not a cast. Postgres refuses ::timestamptz AND ::timestamp
      // in an index expression (both casts are STABLE — DateStyle/TimeZone
      // dependent). Text is exact here because writes store fixed-width
      // canonical UTC ISO, which sorts lexicographically = chronologically.
      // `query.ts` compares indexed date fields as text against a canonicalized
      // value so the planner can actually use this index.
      return raw;
    case "boolean":
      return `((${raw})::boolean)`;
    default:
      return raw;
  }
}

/**
 * Scale A2: per-collection partial expression indexes for `indexed` fields, so
 * FILTER/SORT by them is a seek instead of a JSONB scan. Same DROP-old/CREATE-new
 * diff as unique/search, keyed on (name, type) so a retype rebuilds with the
 * right cast. Non-concurrent to match the existing index-sync; online adds on
 * very large existing collections (CREATE INDEX CONCURRENTLY) are a follow-up.
 */
async function syncFilterIndexes(
  projectId: string,
  collectionId: string,
  oldFields: FieldDef[],
  newFields: FieldDef[],
): Promise<void> {
  const idx = (fs: FieldDef[]) => new Map(fs.filter((f) => f.indexed).map((f) => [f.name, f]));
  const oldIdx = idx(oldFields);
  const newIdx = idx(newFields);
  const tdb = await tenantDb(projectId);
  for (const [name, f] of oldIdx) {
    const nf = newIdx.get(name);
    if (!nf || nf.type !== f.type) {
      await tdb.execute(sql.raw(`DROP INDEX IF EXISTS "${filterIndexName(collectionId, name)}"`));
    }
  }
  for (const [name, f] of newIdx) {
    const of = oldIdx.get(name);
    if (of && of.type === f.type) continue; // unchanged
    // A3: a date index is a TEXT index, so it is only correct while every
    // stored value is canonical UTC ISO. Writes have canonicalized since A5,
    // but rows written before it (or imported) may carry another offset — and
    // '2026-07-04T10:00+02:00' sorts nowhere near the same instant written as
    // '...08:00:00.000Z'. Canonicalize first, exactly as the unique-index path
    // does for the same reason. Unparseable values are left alone rather than
    // destroyed; they sort as text, which is what they already did.
    if (f.type === "date") {
      try {
        await tdb.execute(sql`
          UPDATE entries
          SET data = jsonb_set(
            data, ARRAY[${name}]::text[],
            to_jsonb(to_char((data->>${name})::timestamptz AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
          WHERE collection_id = ${collectionId}
            AND data ? ${name}
            AND (data->>${name}) IS NOT NULL
            AND (data->>${name}) !~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'`);
      } catch {
        // A row whose value will not parse as a timestamp blocks the whole
        // statement. The index is still correct for the canonical majority and
        // the outliers keep their existing (text) ordering, so this must not
        // fail the define.
      }
    }
    await tdb.execute(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS "${filterIndexName(collectionId, name)}" ` +
          `ON entries (${filterIndexExpr(f)}) WHERE collection_id = '${collectionId}'`,
      ),
    );
  }
}

/**
 * A2: replay every collection's per-collection partial indexes (unique +
 * public-search + filter) on the project's data plane. Provisioning runs this right
 * after the migration runner installs the fixed table set — these indexes are
 * derived from collection config, so they are not part of the versioned DDL.
 * Idempotent (CREATE/DROP IF [NOT] EXISTS all the way down).
 */
export async function replayCollectionIndexes(projectId: string): Promise<void> {
  // Direct (uncached) read: this runs in provisioning contexts, which must see
  // the current config and may execute outside a Next request entirely.
  const cols = await db
    .select({ id: collections.id, fields: collections.fields })
    .from(collections)
    .where(eq(collections.projectId, projectId));
  for (const c of cols) {
    await syncUniqueIndexes(projectId, c.id, [], c.fields as FieldDef[]);
    await syncSearchIndex(projectId, c.id, [], c.fields as FieldDef[]);
    await syncFilterIndexes(projectId, c.id, [], c.fields as FieldDef[]);
    await syncCapacityTriggers(projectId, c.id, [], c.fields as FieldDef[]);
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
  | { applied: true; collection: Collection; diff?: SchemaDiff; constraintWarnings?: ConstraintWarning[]; accessNote?: string }
  | { applied: false; requiresConfirmation: true; diff: SchemaDiff; hint: string }
  /** DX-7: the dry-run plan — everything the real call would report, nothing done. */
  | {
      applied: false;
      dryRun: true;
      wouldCreate?: boolean;
      fieldCount?: number;
      diff?: SchemaDiff;
      wouldRequireConfirmation?: boolean;
      constraintWarnings?: ConstraintWarning[];
      accessNote?: string;
      hint: string;
    };

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
  dbc: DbExecutor,
  collectionId: string,
  oldFields: FieldDef[],
  newFields: FieldDef[],
  renames: { from: string; to: string }[],
): Promise<ConstraintWarning[]> {
  const renamedFrom = new Map(renames.map((r) => [r.to, r.from]));
  const warnings: ConstraintWarning[] = [];

  const countWhere = async (key: string, cond: ReturnType<typeof sql>): Promise<number> => {
    const rows = await dbc
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
        const rows = await dbc
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
 * J5: collection-level localized-field rules — everything the meta-schema
 * can't see because it needs the project registry or sibling collections.
 * (a) the knob needs set_locales; (b) a relation may not point at a localized
 * labelField (resolveRelations/aggregate labels stringify ONE value); (c) a
 * field that is an inbound relation's labelField may not become localized;
 * (d) toggling localized on a populated field waits for the backfill increment.
 */
async function validateLocalizedFields(
  projectId: string,
  name: string,
  fields: FieldDef[],
  existing: Collection[],
  current: Collection | undefined,
  renames: { from: string; to: string }[],
): Promise<void> {
  const localized = fields.filter(fieldLocalized);
  if (localized.length > 0 && !(await getLocales(projectId))) {
    throw new ValidationError(
      "localized fields need the project's locale registry — call set_locales {default, supported} first",
    );
  }
  for (const f of fields) {
    if (f.type !== "relation") continue;
    const targetFields =
      f.targetCollection === name
        ? fields
        : (existing.find((c) => c.name === f.targetCollection)?.fields as FieldDef[] | undefined);
    const label = targetFields?.find((x) => x.name === f.labelField);
    if (label && fieldLocalized(label)) {
      throw new ValidationError(
        `relation "${f.name}": labelField "${f.labelField}" on "${f.targetCollection}" is localized — a label is one printable value; pick a non-localized labelField`,
      );
    }
  }
  for (const lf of localized) {
    const refs = existing
      .filter((c) => c.name !== name)
      .flatMap((c) =>
        (c.fields as FieldDef[])
          .filter((x) => x.type === "relation" && x.targetCollection === name && x.labelField === lf.name)
          .map((x) => `${c.name}.${x.name}`),
      );
    if (refs.length > 0) {
      throw new ValidationError(
        `"${lf.name}" cannot be localized — it is the labelField of inbound relation(s) ${refs.join(", ")}; point those at a non-localized field first`,
      );
    }
  }
  // J8: toggling localized on a populated field is legal — localize wraps
  // existing values under the default locale (non-destructive, immediate);
  // delocalize is a counted plan + confirm in defineCollection's diff gate.
}

/**
 * SEC-1: the write-only rules a single field def cannot see, because they need
 * sibling collections. Both directions of the relation-label rule, mirroring the
 * localized pair above:
 *
 *  (a) a relation may not point its labelField at a write-only field — the
 *      {id,label} channel resolves that value on every read of the PARENT, which
 *      would launder the secret out through a collection that does not even
 *      declare it;
 *  (b) a field that is an inbound relation's labelField may not BECOME
 *      write-only, or (a) would be violated retroactively by editing the target.
 *
 * These are define-time refusals rather than runtime redactions on purpose:
 * label resolution runs on the trusted read path with no target-collection
 * lookup, and adding one to every MCP read to defend a schema that should never
 * have been accepted is the wrong place to pay.
 */
function validateWriteOnlyFields(
  name: string,
  fields: FieldDef[],
  existing: Collection[],
): void {
  for (const f of fields) {
    if (f.type !== "relation") continue;
    const targetFields =
      f.targetCollection === name
        ? fields
        : (existing.find((c) => c.name === f.targetCollection)?.fields as FieldDef[] | undefined);
    const label = targetFields?.find((x) => x.name === f.labelField);
    if (label && fieldWriteOnly(label)) {
      throw new ValidationError(
        `relation "${f.name}": labelField "${f.labelField}" on "${f.targetCollection}" is write-only — a label is READ on every fetch of this collection; point the relation at a readable field`,
      );
    }
  }
  for (const wf of fields.filter(fieldWriteOnly)) {
    const refs = existing
      .filter((c) => c.name !== name)
      .flatMap((c) =>
        (c.fields as FieldDef[])
          .filter((x) => x.type === "relation" && x.targetCollection === name && x.labelField === wf.name)
          .map((x) => `${c.name}.${x.name}`),
      );
    if (refs.length > 0) {
      throw new ValidationError(
        `"${wf.name}" cannot be write-only — it is the labelField of inbound relation(s) ${refs.join(", ")}, which read it on every fetch; point those at another field first`,
      );
    }
  }
}

/**
 * J8: detect localized-flag toggles (rename-aware) and count their impact —
 * queried under the OLD key names, before the rename backfill runs.
 */
async function planLocalizedToggles(
  dbc: DbExecutor,
  current: Collection,
  fields: FieldDef[],
  renames: { from: string; to: string }[],
  defaultLocale: string | null,
): Promise<{
  localized: NonNullable<SchemaDiff["localized"]>;
  delocalized: NonNullable<SchemaDiff["delocalized"]>;
  /** Post-backfill UPDATE targets (NEW field names). */
  wraps: string[];
  collapses: string[];
}> {
  const renamedFrom = new Map(renames.map((r) => [r.to, r.from]));
  const localized: NonNullable<SchemaDiff["localized"]> = [];
  const delocalized: NonNullable<SchemaDiff["delocalized"]> = [];
  const wraps: string[] = [];
  const collapses: string[] = [];

  for (const f of fields) {
    const oldName = renamedFrom.get(f.name) ?? f.name;
    const old = (current.fields as FieldDef[]).find((x) => x.name === oldName);
    if (!old || fieldLocalized(old) === fieldLocalized(f)) continue;

    const key = sql`${entries.data} -> ${oldName}::text`;
    if (fieldLocalized(f)) {
      const [row] = await dbc
        .select({ n: sql<number>`count(*)::int` })
        .from(entries)
        .where(and(eq(entries.collectionId, current.id), sql`jsonb_typeof(${key}) = 'string'`));
      localized.push({ field: f.name, entriesToWrap: row.n });
      wraps.push(f.name);
    } else {
      const [affected] = await dbc
        .select({ n: sql<number>`count(*)::int` })
        .from(entries)
        .where(and(eq(entries.collectionId, current.id), sql`jsonb_typeof(${key}) = 'object'`));
      const [losing] = await dbc
        .select({ n: sql<number>`count(*)::int` })
        .from(entries)
        .where(
          and(
            eq(entries.collectionId, current.id),
            sql`jsonb_typeof(${key}) = 'object'`,
            sql`NOT jsonb_exists(${key}, ${defaultLocale ?? ""}::text)`,
          ),
        );
      const keyRows = (await dbc.execute(
        sql`SELECT DISTINCT jsonb_object_keys(${key}) AS k FROM entries
            WHERE collection_id = ${current.id} AND jsonb_typeof(${key}) = 'object'`,
      )) as unknown as { rows?: { k: string }[] };
      const allLocales = ((keyRows.rows ?? []) as { k: string }[]).map((r) => r.k);
      delocalized.push({
        field: f.name,
        entriesAffected: affected.n,
        variantsLost: allLocales.filter((l) => l !== defaultLocale),
        entriesLosingField: losing.n,
      });
      collapses.push(f.name);
    }
  }
  return { localized, delocalized, wraps, collapses };
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
  // v1.1b: resolve library block refs (blocks:["hero"]) BEFORE meta-validation —
  // stored fields stay fully materialized, so nothing downstream changes.
  const library = await getBlockLibrary(projectId); // direct read — resolution must never see a stale library
  const fields = validateFieldDefs(resolveLibraryBlocks(input.fields, library));

  // publicFilter clauses must be valid against these fields (throws with hint).
  if (input.publicFilter?.length) buildWhere(fields, input.publicFilter);
  await validateAccessAndEvents(projectId, fields, input.access, input.events, input.publicWrite ?? false);

  // G4: the state machine's field/states/transitions must be internally valid;
  // transition actions get the same validation as event actions.
  if (input.workflow) {
    validateWorkflow(input.workflow, fields, (actions) => {
      for (const a of actions) {
        if (a.type === "webhook") {
          if (!/^https?:\/\//.test(a.url)) throw new ValidationError("workflow action: webhook url must be http(s)");
        } else if (a.type === "email") {
          if (!a.to || !a.subject) throw new ValidationError("workflow action: email actions need to + subject");
          assertNoLocalizedTemplateRefs(fields, a, "workflow action");
        } else {
          throw new ValidationError('workflow action: type must be "webhook" or "email"');
        }
        if (a.when?.length) buildWhere(fields, a.when);
        if (a.after !== undefined) {
          throw new ValidationError(
            "workflow action: transition actions fire immediately — `after` is not supported on transitions yet; use an entry event action for delayed sends",
          );
        }
      }
    });
    // 2a: custom senders on transition emails — approved-sender gate (the
    // validateWorkflow callback is sync, so this runs after it).
    for (const a of input.workflow.transitions.flatMap((t) => t.actions ?? [])) {
      if (a.type === "email" && a.from) {
        const refusal = await senderRefusal(projectId, a.from);
        if (refusal) throw new ValidationError(`workflow action: ${refusal}`);
      }
    }
    const hasEmail = input.workflow.transitions
      .flatMap((t) => t.actions ?? [])
      .some((a) => a.type === "email");
    if (hasEmail && !(await hasProvider(projectId, "email"))) {
      throw new ValidationError(
        "workflow: email transition actions need an email provider — connect Resend or Elastic Email in project settings first",
        "E_CONNECTOR_REQUIRED",
      );
    }
  }

  // K2a: declarative Stripe checkout. Validated on EVERY definition write, so a
  // later redefine can't flip a sellable collection to a private access.read.
  if (input.checkout) {
    await validateCheckout(projectId, input.checkout, fields, input.access);
  }
  if (input.hooks) {
    await validateHooks(projectId, input.hooks, fields);
  }

  // Relation targets must resolve to a real collection in this project.
  const existing = await listCollections(projectId);
  const known = new Set(existing.map((c) => c.name).concat(name));
  // #19 (feedback): the collections cache lags a just-created collection
  // (revalidateTag is eventually consistent), so defining `leads` with a
  // relation to a `ranches` created moments earlier would falsely fail. Confirm
  // any "missing" target against a FRESH read before erroring — and surface it
  // as E_VALIDATION (a fixable input error), not an opaque E_INTERNAL.
  let freshNames: Set<string> | null = null;
  for (const f of fields) {
    if (f.type !== "relation" || known.has(f.targetCollection)) continue;
    if (!freshNames) {
      const rows = await db.select({ name: collections.name }).from(collections).where(eq(collections.projectId, projectId));
      freshNames = new Set(rows.map((r) => r.name));
      freshNames.add(name);
    }
    if (!freshNames.has(f.targetCollection)) {
      throw new ValidationError(
        `relation field "${f.name}" targets unknown collection "${f.targetCollection}" — create that collection first, then define this one`,
        "E_VALIDATION",
      );
    }
  }

  // K4 invariant #8: if THIS collection is the orders target of a sellable
  // collection, re-validate that mapping against the PROPOSED fields — so
  // narrowing the status enum or adding a required field can't silently break
  // live orders (the mapping lives on the OTHER collection, so its own
  // validateCheckout above never re-checks it on this write).
  for (const other of existing) {
    if (other.name === name) continue;
    const mapping = other.checkout?.orders;
    if (mapping?.collection === name) {
      assertOrdersMapping(mapping, fields, name);
    }
  }

  // Destructive-change gate for existing collections.
  // #11/#19 (feedback): `current` MUST be the TRUE stored state, read FRESH —
  // a cached read that lags a recent create/update would return undefined and
  // make this redefine look like a NEW collection, bypassing the whole gate and
  // silently dropping the workflow (or fields). The gate's correctness can't
  // depend on cache propagation.
  const [freshCurrent] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.projectId, projectId), eq(collections.name, name)))
    .limit(1);
  const current = freshCurrent ? revive(freshCurrent as Collection) : undefined;
  if (!current) await assertCollectionCap(projectId); // B2 sandbox cap — new collections only
  const renames = input.renames ?? [];
  validateRenames(current, fields, renames);
  await validateLocalizedFields(projectId, name, fields, existing, current, renames);
  validateWriteOnlyFields(name, fields, existing);
  let diff: SchemaDiff | undefined;
  let toggleWraps: string[] = [];
  let toggleCollapses: string[] = [];
  const projectLocales = await getLocales(projectId);
  // Data scans + backfills below read/write tenant entries; resolve once.
  const tdb = await tenantDb(projectId);
  if (current) {
    const structural = diffFields(current.fields, fields, renames);
    const dangerousKeys = [
      ...structural.removed,
      ...structural.retyped.map((r) => r.field),
    ];
    const affectedEntries = await countEntriesWithKeys(tdb, current.id, dangerousKeys);
    // #11 (feedback): omitting `workflow` on a redefine REMOVES the state
    // machine — silently dropping live status-transition enforcement. A redefine
    // is full-replace, so any additive change that forgets to resend the
    // workflow would destroy it. Treat removal as destructive: gate on confirm,
    // exactly like a dropped field, so it can never happen by accident.
    const workflowRemoved = Boolean(current.workflow) && !input.workflow;
    // MT-4: the same trap one subsystem over. A redefine is FULL-REPLACE, so an
    // additive change that forgets to resend `access` silently un-gates the
    // collection — and unlike a dropped field, nothing breaks: every read and
    // write keeps working, it just stops checking who is asking. The workflow
    // gate above (#11, 6256c51) is the precedent; this is the identical shape,
    // and the reason it is worth a gate rather than a warning is that the
    // failure is unobservable from the response.
    const prevAccess = current.access as
      | { read?: unknown; write?: unknown; org?: unknown }
      | null
      | undefined;
    const accessRemoved =
      prevAccess && !input.access
        ? {
            read: prevAccess.read !== undefined,
            write: prevAccess.write !== undefined,
            org: prevAccess.org !== undefined,
          }
        : null;
    // J8: localized-flag toggles — wrap counts ride the diff for visibility;
    // a delocalize (variants dropped) joins the confirm gate like a removal.
    const toggles = await planLocalizedToggles(tdb, current, fields, renames, projectLocales?.default ?? null);
    toggleWraps = toggles.wraps;
    toggleCollapses = toggles.collapses;
    diff = {
      ...structural,
      affectedEntries,
      ...(workflowRemoved ? { workflowRemoved: true } : {}),
      ...(accessRemoved ? { accessRemoved } : {}),
      ...(toggles.localized.length > 0 ? { localized: toggles.localized } : {}),
      ...(toggles.delocalized.length > 0 ? { delocalized: toggles.delocalized } : {}),
    };
    const destructiveDelocalize = toggles.delocalized.some(
      (d) => d.entriesAffected > 0 && (d.variantsLost.length > 0 || d.entriesLosingField > 0),
    );
    // DX-7: the dry-run exit for an EXISTING collection — after every validation
    // and the complete diff, before the first write (index sync is the earliest
    // side effect below). Runs the tightening scan too (read-only counts), so
    // the dry plan carries everything the real apply would report, including
    // whether that apply would demand confirm.
    if (input.dryRun) {
      const wouldRequireConfirmation =
        dangerousKeys.length > 0 || destructiveDelocalize || workflowRemoved || Boolean(accessRemoved);
      const dryWarnings = await scanConstraintTightening(tdb, current.id, current.fields, fields, renames);
      const accessNote = buildAccessNotes(input, fields);
      return {
        applied: false,
        dryRun: true,
        diff,
        ...(wouldRequireConfirmation ? { wouldRequireConfirmation: true } : {}),
        ...(dryWarnings.length > 0 ? { constraintWarnings: dryWarnings } : {}),
        ...(accessNote ? { accessNote } : {}),
        hint: wouldRequireConfirmation
          ? "dry run — nothing applied. This change is DESTRUCTIVE: the real call will require confirm: true (the diff above is exactly what it will show)."
          : "dry run — nothing applied. Re-send without dryRun to apply this plan.",
      };
    }
    if (
      (dangerousKeys.length > 0 || destructiveDelocalize || workflowRemoved || accessRemoved) &&
      !input.confirm
    ) {
      const dropped = accessRemoved
        ? (["read", "write", "org"] as const).filter((k) => accessRemoved[k]).join(", ")
        : "";
      return {
        applied: false,
        requiresConfirmation: true,
        diff,
        hint: workflowRemoved
          ? "destructive change — this REMOVES the workflow state machine (status transitions stop being enforced). Re-send the `workflow` to keep it, or re-run with confirm: true to remove it."
          : accessRemoved
            ? `destructive change — this REMOVES the collection's identity rules (access.${dropped}). Reads/writes would keep succeeding but STOP being gated, so nothing would look broken. A redefine is full-replace: re-send \`access\` to keep the rules, or re-run with confirm: true to un-gate the collection deliberately.`
          : destructiveDelocalize
            ? "destructive change — delocalizing drops every non-default variant (entries without a default variant lose the field); re-run with confirm: true to apply"
            : "destructive change — re-run with confirm: true to apply",
      };
    }
  }

  // DX-7: the dry-run exit for a NEW collection — every validator above has
  // passed, nothing exists to diff, nothing is written.
  if (input.dryRun) {
    const accessNote = buildAccessNotes(input, fields);
    return {
      applied: false,
      dryRun: true,
      wouldCreate: true,
      fieldCount: fields.length,
      ...(accessNote ? { accessNote } : {}),
      hint: `dry run — nothing created. "${name}" does not exist; the real call would create it with ${fields.length} field(s).`,
    };
  }

  // Sync indexes BEFORE persisting the definition: if enabling unique fails on
  // existing duplicates, the stored schema must not claim a constraint the DB
  // doesn't enforce. (New collections sync after insert — they have no rows,
  // so index creation cannot fail.)
  if (current) {
    await syncUniqueIndexes(projectId, current.id, current.fields, fields);
    await syncSearchIndex(projectId, current.id, current.fields, fields);
    await syncFilterIndexes(projectId, current.id, current.fields, fields);
    await syncCapacityTriggers(projectId, current.id, current.fields, fields);
  }

  // Tightened validator-level constraints apply to NEW writes immediately;
  // existing rows keep their values. Count what now violates, warn-only.
  const constraintWarnings = current
    ? await scanConstraintTightening(tdb, current.id, current.fields, fields, renames)
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
    workflow: input.workflow ?? null,
    checkout: input.checkout ?? null,
    hooks: input.hooks ?? null,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(collections)
    .values(values)
    .onConflictDoUpdate({
      target: [collections.projectId, collections.name],
      ...(input.expectUpdatedAt
        ? { setWhere: eq(collections.updatedAt, input.expectUpdatedAt) }
        : {}),
      set: {
        displayName: values.displayName,
        fields: values.fields,
        publicWrite: values.publicWrite,
        webhookUrl: values.webhookUrl,
        publicFilter: values.publicFilter,
        access: values.access,
        events: values.events,
        workflow: values.workflow,
        checkout: values.checkout,
        hooks: values.hooks,
        updatedAt: values.updatedAt,
      },
    })
    .returning();

  // setWhere failed => zero rows => somebody else wrote first. Nothing has been
  // applied, so this is safe to retry.
  if (!row) throw new SchemaConflictError(input.name);

  if (!current) {
    await syncUniqueIndexes(projectId, row.id, [], fields);
    await syncSearchIndex(projectId, row.id, [], fields);
    await syncFilterIndexes(projectId, row.id, [], fields);
    await syncCapacityTriggers(projectId, row.id, [], fields);
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
    if (r.field) {
      // ENUM OPTION rename: rewrite the VALUE in place, leaving the key alone.
      // Without this an option change orphaned every row still holding the old
      // value — it stayed stored, but the enum no longer permitted it, so the
      // row failed validation on its next save and matched a filter on neither
      // the old name nor the new one. Live AND trash, so a restore does not
      // resurrect a value the schema rejects.
      for (const table of [sql`entries`, sql`entries_trash`]) {
        await tdb.execute(
          sql`UPDATE ${table}
              SET data = jsonb_set(data, ARRAY[${r.field}]::text[], to_jsonb(${r.to}::text))
              WHERE collection_id = ${row.id} AND data->>${r.field} = ${r.from}`,
        );
      }
      continue;
    }
    await tdb.execute(
      sql`UPDATE entries
          SET data = (data - ${r.from}::text) || jsonb_build_object(${r.to}::text, data->${r.from}::text)
          WHERE collection_id = ${row.id} AND data ? ${r.from}::text`,
    );
    await tdb.execute(
      sql`UPDATE entries_trash
          SET data = (data - ${r.from}::text) || jsonb_build_object(${r.to}::text, data->${r.from}::text)
          WHERE collection_id = ${row.id} AND data ? ${r.from}::text`,
    );
  }

  // J8: localized-flag toggle backfills — AFTER the rename backfill, so they
  // target the new key names; live + trash, like renames. Same read-window
  // caveat as renames (see above); do schema toggles when quiescent.
  if ((toggleWraps.length > 0 || toggleCollapses.length > 0) && projectLocales) {
    const def = projectLocales.default;
    for (const table of ["entries", "entries_trash"] as const) {
      const t = sql.raw(table);
      for (const f of toggleWraps) {
        // Localize ON: wrap existing plain strings under the default locale.
        await tdb.execute(
          sql`UPDATE ${t}
              SET data = jsonb_set(data, ARRAY[${f}::text], jsonb_build_object(${def}::text, data->${f}::text))
              WHERE collection_id = ${row.id} AND jsonb_typeof(data->${f}::text) = 'string'`,
        );
      }
      for (const f of toggleCollapses) {
        // Delocalize (confirmed): keep the default variant as the plain value…
        await tdb.execute(
          sql`UPDATE ${t}
              SET data = jsonb_set(data, ARRAY[${f}::text], data->${f}::text->${def}::text)
              WHERE collection_id = ${row.id} AND jsonb_typeof(data->${f}::text) = 'object'
                AND jsonb_exists(data->${f}::text, ${def}::text)`,
        );
        // …and drop the key entirely where no default variant exists — a text
        // field must never hold JSON null (openMinor #4).
        await tdb.execute(
          sql`UPDATE ${t}
              SET data = data - ${f}::text
              WHERE collection_id = ${row.id} AND jsonb_typeof(data->${f}::text) = 'object'`,
        );
      }
    }
  }

  revalidateTag(collectionsTag(projectId));
  // Wall report (Fatsoz): publicWrite + a non-none access.write is a legal but
  // easily-misread combo — the write RULES replace the anonymous path, so the
  // "public" in publicWrite silently stops meaning anonymous. Say it out loud
  // in the response instead of letting the integrator discover it via 401s.
  const writeRules = input.access?.write;
  const writeList = writeRules === undefined ? ["none"] : Array.isArray(writeRules) ? writeRules : [writeRules];
  // A5: publicWrite + a write rule is no longer a conflict to warn about — the
  // two COMPOSE. It is still worth saying out loud, because which half governs
  // which verb is the thing authors get wrong.
  const accessNote = buildAccessNotes(input, fields);
  return {
    applied: true,
    collection: row,
    diff,
    ...(constraintWarnings.length > 0 ? { constraintWarnings } : {}),
    ...(accessNote ? { accessNote } : {}),
  };
}

/** The define-response coaching notes (composed-write + WP-9 publicRead), shared
 *  by the real apply and the DX-7 dry run so both tell the same story. */
function buildAccessNotes(input: DefineCollectionInput, fields: FieldDef[]): string | undefined {
  const writeRules0 = input.access?.write;
  const writeList = writeRules0 === undefined ? ["none"] : Array.isArray(writeRules0) ? writeRules0 : [writeRules0];
  const composedWrite = (input.publicWrite ?? false) && !(writeList.length === 1 && writeList[0] === "none");
  const accessNotes: string[] = [];
  if (composedWrite) {
    accessNotes.push(
      "publicWrite + access.write COMPOSE: anonymous POST stays open (publicWrite governs it), while " +
        "PATCH/DELETE require access.write — this is the 'anyone submits, only staff triage' shape. A " +
        "signed-in user who does not meet access.write may still POST (they could drop the token and " +
        "post anonymously anyway), but their row is attributed to them. To close anonymous submission, " +
        "set publicWrite:false.",
    );
  }
  // WP-9 (wall 21f4c5d5): access.read gates WHO may read; publicRead still
  // chooses WHICH fields are served — for AUTHENTICATED readers too, which the
  // name does not suggest. An agent that gated reads and skipped publicRead on
  // "non-public" fields shipped an app receiving near-empty rows with no error.
  // A NOTE rather than a warning: hidden fields on a gated collection are often
  // exactly right (auth_kit is full of them) — the note makes the semantics
  // impossible to misread once, and names the fields so the fix is one glance.
  const readRules = input.access?.read;
  const readList = readRules === undefined ? ["public"] : Array.isArray(readRules) ? readRules : [readRules];
  const readGated = readList.some((r) => r !== "public");
  if (readGated) {
    const hidden = fields.filter((f) => !f.publicRead).map((f) => f.name);
    const served = fields.length - hidden.length;
    accessNotes.push(
      `access.read gates WHO can read on delivery; publicRead still chooses WHICH fields are served — ` +
        `for authenticated readers too, not just anonymous ones. This collection serves ${served} of ` +
        `${fields.length} fields` +
        (hidden.length > 0
          ? ` (delivery-hidden: ${hidden.join(", ")}). If your app needs one of those, set publicRead:true on it`
          : "") +
        (served === 0
          ? `. With ZERO delivery-visible fields this collection is NOT on the delivery API at all (404, identity-independent) — readable over MCP only`
          : "") +
        `.`,
    );
  }
  // MT-7: a claim rule reads a CUSTOM CLAIM off the end user's JWT — which
  // exists only if the tenant added it in THEIR Clerk instance. Nothing said so
  // at define time: the contract mentioned only "requires the project's Clerk
  // connector", which is about CONNECTING the connector, a different thing. And
  // the gate is fail-closed, so the collection appears to work — as "nobody can
  // read this" — until someone tests it days later, at which point the fix is a
  // dashboard action no agent can perform. The runtime refusals name the fix
  // well (claimDenied/orgDenied in lib/access-rules.ts); this moves the same
  // information to the moment the rule is DECLARED, so it becomes one clear ask
  // bundled with everything else the agent is already reporting.
  const claimNames = new Set<string>();
  for (const r of [...readList, ...writeList]) {
    if (r && typeof r === "object" && "claim" in r && typeof (r as { claim?: unknown }).claim === "string") {
      claimNames.add((r as { claim: string }).claim);
    }
  }
  const orgClaim = input.access?.org?.claim;
  if (orgClaim) claimNames.add(orgClaim);
  if (claimNames.size > 0) {
    const list = [...claimNames].sort();
    const tmpl = list.map((c) => `"${c}": "{{user.public_metadata.${c}}}"`).join(", ");
    accessNotes.push(
      "IDENTITY SETUP REQUIRED, and it is not in this platform. " +
        `${list.length === 1 ? "This rule reads" : "These rules read"} the custom claim ` +
        `${list.map((c) => `"${c}"`).join(", ")} off the END USER's JWT, which your Clerk instance issues ` +
        "only if you add it: Clerk dashboard -> Sessions -> Customize session token -> " +
        `{${tmpl}} (point the source at wherever you store it), then Save. ` +
        "A claim must resolve to a FLAT STRING — a nested or object claim never matches, because the " +
        "match is fail-closed. UNTIL THAT IS DONE THIS COLLECTION LOOKS FINE AND SERVES NOBODY: define " +
        "succeeds, and delivery answers 403 for every signed-in user. Verify with a real end-user token " +
        "before building against it" +
        (orgClaim ? "; org scoping additionally needs the user to have an active organization" : "") +
        ".",
    );
  }
  return accessNotes.length > 0 ? accessNotes.join("\n\n") : undefined;
}

/**
 * OPS-6 (wall `ad7568ba`, xvibe) — one-call factory reset for burn/test
 * projects. Before this, a clean slate took N delete_collection calls in
 * dependency order (E_BLOCKED on relation targets) plus schedule/plugin
 * cleanup — painful for agent eval harnesses, and for our own smoke suite,
 * whose stranded-project sweeper exists because teardown is hard.
 *
 * Scope decisions, stated because each is a judgment call:
 *  - KEEPS tokens (deleting the caller's own credential mid-call is a trap)
 *    and connectors (project identity — provider keys survive a content wipe).
 *  - KEEPS the audit log and platform usage counters: the trail of what
 *    happened — including this reset — is not the project's content.
 *  - WIPES the change feed. Synced clients must treat a reset as a full
 *    resync; no tombstone stream survives a factory reset, and pretending
 *    otherwise would be a lie shaped like convergence.
 *  - Deletes tenant asset ROWS but keeps control-side assetPointers — the
 *    existing R2 orphan sweep reaps the bytes from exactly that diff.
 *  - Inbound relation ordering does not apply: everything goes, so the
 *    E_BLOCKED protection (which exists to prevent dangling references) has
 *    nothing left to protect.
 */
export interface ResetPlan {
  collections: number;
  liveEntries: number;
  trashedEntries: number;
  versionSnapshots: number;
  feedRows: number;
  assets: number;
  libraryBlocks: number;
  schedules: number;
  jobs: number;
  pluginEnables: number;
  localesConfigured: boolean;
  inboundConfigured: boolean;
  deliveryLogRows: number;
  /** What a reset deliberately does NOT touch. */
  kept: string[];
}

const RESET_KEEPS = [
  "tokens (revoking your own credential mid-call is a trap — revoke_delivery_token exists)",
  "connectors (provider keys are project identity, not content)",
  "audit log + platform usage counters (the record of what happened, including this reset)",
  "branding/settings",
  "project-authored plugin definitions (delete_plugin removes them individually)",
];

export async function planResetProject(projectId: string): Promise<ResetPlan> {
  const tdb = await tenantDb(projectId);
  const [
    cols,
    [live],
    [trashed],
    [versions],
    [feed],
    [assetRows],
    [proj],
    scheds,
    jobRows,
    plugRows,
    [deliveries],
  ] = await Promise.all([
    db.select({ n: count() }).from(collections).where(eq(collections.projectId, projectId)),
    tdb.select({ n: count() }).from(entries).where(eq(entries.projectId, projectId)),
    tdb.select({ n: count() }).from(entriesTrash).where(eq(entriesTrash.projectId, projectId)),
    tdb.select({ n: count() }).from(entryVersions).where(eq(entryVersions.projectId, projectId)),
    tdb.execute(sql`SELECT count(*)::int AS n FROM entry_changes WHERE project_id = ${projectId}`).then(
      (r) => ((r as unknown as { rows?: { n: number }[] }).rows ?? (r as unknown as { n: number }[])) as { n: number }[],
    ),
    tdb.execute(sql`SELECT count(*)::int AS n FROM assets WHERE project_id = ${projectId}`).then(
      (r) => ((r as unknown as { rows?: { n: number }[] }).rows ?? (r as unknown as { n: number }[])) as { n: number }[],
    ),
    db.select({ locales: projects.locales, blockLibrary: projects.blockLibrary, inboundConfig: projects.inboundConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),
    db.execute(sql`SELECT count(*)::int AS n FROM project_schedules WHERE project_id = ${projectId}`),
    db.execute(sql`SELECT count(*)::int AS n FROM jobs WHERE project_id = ${projectId}`),
    db.execute(sql`SELECT count(*)::int AS n FROM project_plugins WHERE project_id = ${projectId}`),
    db.execute(sql`SELECT count(*)::int AS n FROM webhook_deliveries WHERE project_id = ${projectId}`).then(
      (r) => ((r as unknown as { rows?: { n: number }[] }).rows ?? (r as unknown as { n: number }[])) as { n: number }[],
    ),
  ]);
  const one = (r: unknown): number => {
    const rows = ((r as unknown as { rows?: { n: number }[] }).rows ?? (r as unknown as { n: number }[])) as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  };
  return {
    collections: Number(cols[0]?.n ?? 0),
    liveEntries: Number(live?.n ?? 0),
    trashedEntries: Number(trashed?.n ?? 0),
    versionSnapshots: Number(versions?.n ?? 0),
    feedRows: Number(feed?.n ?? 0),
    assets: Number(assetRows?.n ?? 0),
    libraryBlocks: Object.keys(proj?.blockLibrary ?? {}).length,
    schedules: one(scheds),
    jobs: one(jobRows),
    pluginEnables: one(plugRows),
    localesConfigured: proj?.locales != null,
    inboundConfigured: proj?.inboundConfig != null,
    deliveryLogRows: Number(deliveries?.n ?? 0),
    kept: RESET_KEEPS,
  };
}

/** Execute the wipe the plan describes. Returns the plan it acted on. */
export async function resetProject(projectId: string): Promise<ResetPlan> {
  const plan = await planResetProject(projectId);
  const tdb = await tenantDb(projectId);

  // Tenant plane first: content and its histories. Order is cosmetic (no FKs
  // across these), but children-before-parents reads sanely in a failure log.
  for (const table of ["entry_changes", "entry_versions", "entries_trash", "entries", "assets", "transact_receipts"]) {
    await tdb.execute(sql`DELETE FROM ${sql.raw(table)} WHERE project_id = ${projectId}`);
  }

  // Control plane: schema + automation + plugin enables + the delivery log.
  await db.execute(sql`DELETE FROM collections WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM project_schedules WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM jobs WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM project_plugins WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM webhook_deliveries WHERE project_id = ${projectId}`);
  await db
    .update(projects)
    .set({ locales: null, blockLibrary: null, inboundConfig: null })
    .where(eq(projects.id, projectId));

  revalidateTag(collectionsTag(projectId));
  return plan;
}

export interface DeletePlan {
  entryCount: number;
  /** Trashed entries in this collection that a cascade would also destroy. */
  trashedEntries: number;
  /** Relation fields in OTHER collections that target this one. */
  inboundRelations: { collection: string; field: string }[];
  /** H3: `deleted` tombstones appended to the change feed so synced clients
   * converge (= entryCount — one per live entry). */
  changeFeedTombstones: number;
}

/** What deleting a collection would destroy or break. */
export async function planDeleteCollection(
  projectId: string,
  name: string,
): Promise<DeletePlan | null> {
  const target = await getCollection(projectId, name);
  if (!target) return null;

  const tdb = await tenantDb(projectId);
  const [countRows, trashRows, all] = await Promise.all([
    tdb.select({ n: count() }).from(entries).where(eq(entries.collectionId, target.id)),
    tdb.select({ n: count() }).from(entriesTrash).where(eq(entriesTrash.collectionId, target.id)),
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
  const entryCount = countRows[0]?.n ?? 0;
  return {
    entryCount,
    trashedEntries: trashRows[0]?.n ?? 0,
    inboundRelations,
    changeFeedTombstones: entryCount,
  };
}

/** Delete a collection and its entries (cascade on the control DB; explicit
 * sweep on a tenant DB — see below). Caller enforces the plan. */
export async function deleteCollection(projectId: string, name: string): Promise<void> {
  const target = await getCollection(projectId, name);
  const tdb = await tenantDb(projectId);
  if (target) {
    // H3: append a `deleted` tombstone per live entry BEFORE the cascade, so a
    // synced client converges instead of keeping ghost entries. entry_changes
    // has no FK to collections, so these rows outlive the delete. Tombstones-
    // first is safe without a transaction: a spurious tombstone from an aborted
    // delete is harmless (entry still exists → client re-fetches), a LOST one is
    // not — so a chunk-insert failure ABORTS the delete (strict writer throws).
    // vis is computed from the collection's FINAL defs, so the H2 reader serves
    // a tombstone only for an entry that was delivery-visible.
    const CHUNK = 500;
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const rows = await tdb
        .select({ id: entries.id, data: entries.data })
        .from(entries)
        .where(and(eq(entries.collectionId, target.id), gt(entries.id, after)))
        .orderBy(asc(entries.id))
        .limit(CHUNK);
      if (rows.length === 0) break;
      await recordChangesStrict(
        rows.map((r) => ({ projectId, collection: target, kind: "deleted" as const, entryId: r.id, data: r.data })),
      );
      after = rows[rows.length - 1].id;
      if (rows.length < CHUNK) break;
    }
  }

  await db
    .delete(collections)
    .where(and(eq(collections.projectId, projectId), eq(collections.name, name)));
  if (target) {
    // A tenant DB has no FK into the control-plane collections table (A1 accepts
    // the asymmetry), so the ON DELETE CASCADE that clears entries/trash/versions
    // on the control DB does not exist there — sweep explicitly. On the fallback
    // path the cascade has already emptied these and the sweep is a no-op.
    await tdb.execute(sql`DELETE FROM ${entries} WHERE ${entries.collectionId} = ${target.id}`);
    await tdb.execute(sql`DELETE FROM ${entriesTrash} WHERE ${entriesTrash.collectionId} = ${target.id}`);
    await tdb.execute(sql`DELETE FROM ${entryVersions} WHERE ${entryVersions.collectionId} = ${target.id}`);
    // Partial indexes on entries outlive the delete — drop them explicitly.
    await syncUniqueIndexes(projectId, target.id, target.fields, []);
    await syncSearchIndex(projectId, target.id, target.fields, []);
    await syncFilterIndexes(projectId, target.id, target.fields, []);
    await syncCapacityTriggers(projectId, target.id, target.fields, []);
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
