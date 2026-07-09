import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigserial,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { FieldDef } from "@/lib/field-types";
import type { WhereItem } from "@/lib/query";

/** Knobs every event action shares: conditional firing + pause-without-delete. */
interface EventActionBase {
  /** Fire only when the entry snapshot matches ALL items (same shape as query where). */
  when?: WhereItem[];
  /** Paused: kept in the schema, skipped at emit time. */
  disabled?: boolean;
  /**
   * Defer the action: "45m" | "12h" | "3d" (1m..365d). Enqueued as a job at emit
   * time; at SEND time the action is re-read from the collection config and
   * `when` is re-evaluated against the current entry — so disabling, removing,
   * or editing the action also cancels its pending delayed sends (G2).
   */
  after?: string;
}

/** An action fired by an entry event. Email requires the resend connector. */
export type EventAction =
  | ({ type: "webhook"; url: string } & EventActionBase)
  | ({ type: "email"; to: string; subject: string } & EventActionBase);

/** Which surfaces may drive a transition. delivery (end users) is excluded by
 * default — the flagship approval flow is secure unless a transition opts in. */
export type WorkflowActor = "mcp" | "admin" | "delivery";

/** One edge of a state machine: from → to, actor-gated, firing optional actions. */
export interface WorkflowTransition {
  from: string | string[];
  to: string;
  /** Defaults to ["mcp","admin"] — delivery must be listed explicitly. */
  actors?: WorkflowActor[];
  actions?: EventAction[];
}

/**
 * A declarative state machine over one enum field (G4). `initial` is enforced on
 * EVERY create path; transitions are the only way the field moves, actor-gated.
 * Define-time rejects overlapping (from,to) pairs, so from→to resolves exactly
 * one transition.
 */
export interface WorkflowConfig {
  field: string;
  initial: string;
  transitions: WorkflowTransition[];
}

/** K4: maps a paid Checkout Session onto an order entry in another collection. */
export interface CheckoutOrdersConfig {
  collection: string;
  fields: {
    status: string; // enum with pending|paid|expired
    sessionId: string; // text
    total?: string; // number (smallest currency unit)
    customerEmail?: string; // text
    items?: string; // text/richtext — JSON snapshot of the cart
  };
}

/**
 * K2a/K4: declarative Stripe checkout on a collection. `priceField` names a text
 * field holding a Stripe Price id — what is sellable + at what price is
 * server-side content. Sellable collections must be publicly readable (enforced
 * at define time). `orders` (K4) turns paid sessions into order-entry writes.
 */
export interface CheckoutConfig {
  priceField: string;
  successUrl: string;
  cancelUrl: string;
  orders?: CheckoutOrdersConfig;
}

/**
 * I1: a signed synchronous before-write hook to BYO compute — custom
 * validation/transformation without AgentX ever hosting tenant code. At most one
 * per lifecycle stage. `mode:'validate'` only gates the write (I1a); `transform`
 * (I1b) may rewrite the candidate. `onError` decides fail-closed ('reject',
 * default) vs fail-open ('allow') when the endpoint is unreachable/malformed.
 * `when` gates the call by the candidate snapshot (same semantics as events).
 */
export interface WriteHook {
  url: string;
  mode: "validate" | "transform";
  onError?: "reject" | "allow";
  timeoutMs?: number; // 500–5000, default 3000
  when?: WhereItem[];
  disabled?: boolean;
}
export interface HooksConfig {
  beforeCreate?: WriteHook;
  beforeUpdate?: WriteHook;
}

/**
 * Identity presets for the delivery API — parameterized, never an expression
 * language. A ClaimRule matches when a verified JWT custom claim equals one of
 * the given values. A preset ARRAY means any-of (F2). owner/ClaimRule/authenticated
 * are the rungs above public/none.
 */
export interface ClaimRule {
  claim: string;
  equals: string | string[];
}
type ReadPresetOne = "public" | "authenticated" | "owner" | ClaimRule;
type WritePresetOne = "none" | "authenticated" | "owner" | ClaimRule;
export type ReadPreset = ReadPresetOne | ReadPresetOne[];
export type WritePreset = WritePresetOne | WritePresetOne[];
import type { InferSelectModel } from "drizzle-orm";

/**
 * A project = one client site. Everything below is scoped to a project.
 * v1 is dogfood: rows are created by the operator (seed/script), not self-serve.
 */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Branding handed to the client: { displayName, logoUrl, primaryColor, ... } */
  branding: jsonb("branding").$type<Branding>().notNull().default({}),
  /** Signs outgoing webhooks (X-AgentX-Signature); revealed to operators in settings. */
  webhookSigningSecret: text("webhook_signing_secret"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Bearer tokens that scope the single MCP server to one project.
 * We store a SHA-256 hash, never the raw token.
 */
export const projectTokens = pgTable(
  "project_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    scope: text("scope").notNull().default("mcp"),
    label: text("label"),
    /** ≤5-min granularity (token cache TTL); null = never used. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("project_tokens_hash_idx").on(t.tokenHash)],
);

/**
 * A collection definition. `fields` is the schema the AI composed; entries in
 * this collection are validated against it. Public-read is per-field (inside
 * `fields`), so there is no collection-level publicRead flag. publicWrite IS
 * per-collection (a form = a public-write collection).
 */
export const collections = pgTable(
  "collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** URL/slug-safe machine name, unique within a project. */
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    fields: jsonb("fields").$type<FieldDef[]>().notNull().default([]),
    publicWrite: boolean("public_write").notNull().default(false),
    /** Fired on public-write submissions. No email engine — webhook and stop. */
    webhookUrl: text("webhook_url"),
    /** Row visibility for delivery reads: only rows matching ALL clauses are served. */
    publicFilter: jsonb("public_filter").$type<WhereItem[]>(),
    /**
     * Identity rule presets for the delivery API (Phase 4). No expression
     * language — three fixed levels per direction. `owner` requires ownerField
     * to name a text field; it is auto-stamped from the verified JWT sub.
     */
    access: jsonb("access").$type<{
      read?: ReadPreset;
      write?: WritePreset;
      ownerField?: string;
      /** F3: org/team row scoping — {claim, field} stamped like ownerField. */
      org?: { claim: string; field: string };
    }>(),
    /** Declarative event actions: on created/updated/deleted → webhook/email. */
    events: jsonb("events").$type<{
      created?: EventAction[];
      updated?: EventAction[];
      deleted?: EventAction[];
    }>(),
    /** G4: a state machine over one enum field — initial enforced on create,
     * actor-gated transitions the only way it moves. */
    workflow: jsonb("workflow").$type<WorkflowConfig>(),
    /** K2a/K4: declarative Stripe checkout (priceField + success/cancel URLs,
     * optional order-entry mapping). Sellable collections must be public. */
    checkout: jsonb("checkout").$type<CheckoutConfig>(),
    /** I1: signed before-write hooks to BYO compute (at most one per stage). */
    hooks: jsonb("hooks").$type<HooksConfig>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("collections_project_name_idx").on(t.projectId, t.name)],
);

/** An entry = one validated JSONB row belonging to a collection. */
export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    /** Optional client-supplied key: a retried create with the same key is a no-op. */
    idempotencyKey: text("idempotency_key"),
    /** Inbox affordance: when an admin marked this submission handled (publicWrite collections). */
    handledAt: timestamp("handled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("entries_collection_idx").on(t.collectionId),
    uniqueIndex("entries_idempotency_idx")
      .on(t.collectionId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

/**
 * Who can open a project's admin. `operator` manages settings + content;
 * `client` manages content only. Platform operators (ADMIN_EMAILS env) see
 * everything without rows here. This is the tenancy foundation: a future
 * platform user's dashboard = projects where they're a member.
 */
export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull().default("client"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("project_members_user_idx").on(t.projectId, t.clerkUserId)],
);

/**
 * Per-project external service connections (BYO infra). Non-secret config in
 * `config`; secrets AES-256-GCM encrypted in `secretEnc` — never returned to
 * agents or the browser. One row per (project, type).
 */
export const projectConnectors = pgTable(
  "project_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // 'clerk' | 'resend'
    config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
    secretEnc: text("secret_enc"),
    // Named secret slots beyond the primary (e.g. stripe webhookSigning):
    // slot → AES-GCM ciphertext. Upserts merge slots, never drop them.
    secretsEnc: jsonb("secrets_enc").$type<Record<string, string>>(),
    status: text("status").notNull().default("connected"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("project_connectors_type_idx").on(t.projectId, t.type)],
);

/** Outcome log for public-write webhooks — a lost lead must at least be visible. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Nullable since G3: schedule.fired deliveries are project-level (no collection).
    collectionId: uuid("collection_id"),
    url: text("url").notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(), // 'success' | 'failed'
    attempts: text("attempts").notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("webhook_deliveries_project_idx").on(t.projectId)],
);

/** Who changed what: one row per entry mutation, from any surface. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    collectionName: text("collection_name").notNull(),
    entryId: uuid("entry_id").notNull(),
    action: text("action").notNull(), // 'create' | 'update' | 'delete'
    actor: jsonb("actor").$type<AuditActor>().notNull().default({ type: "unknown" }),
    changedFields: jsonb("changed_fields").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("audit_log_project_time_idx").on(t.projectId, t.createdAt)],
);

/** Which surface performed a mutation, and as whom. */
export type AuditActor =
  | { type: "mcp" }
  | { type: "admin"; userId?: string }
  | { type: "delivery"; userSub?: string }
  | { type: "unknown" };

/** Uploaded file metadata; bytes live in R2 under `r2Key`. */
export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  r2Key: text("r2_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: text("size").notNull(),
  url: text("url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Soft-deleted entries. A delete is a row MOVE from `entries` to here (same
 * primary-key uuid), so every visibility path — queries, delivery, aggregates —
 * excludes trashed rows structurally, with zero `deletedAt IS NULL` filters to
 * forget. Restore moves the row back. Purge (Terraform-style plan + confirm)
 * deletes from here permanently.
 */
export const entriesTrash = pgTable(
  "entries_trash",
  {
    id: uuid("id").primaryKey(), // the original entry id, preserved
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).defaultNow().notNull(),
    deletedBy: jsonb("deleted_by").$type<AuditActor>().notNull().default({ type: "unknown" }),
  },
  (t) => [
    index("entries_trash_collection_idx").on(t.collectionId, t.deletedAt),
    index("entries_trash_project_idx").on(t.projectId, t.deletedAt),
  ],
);

/**
 * Point-in-time PRE-image snapshots, written on every update (last 20 per entry).
 * Deliberately NO FK to entries, so history survives a trash round-trip — the
 * entryId may point at a live row, a trashed row, or (until reaped) a purged one.
 */
export const entryVersions = pgTable(
  "entry_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    changedFields: jsonb("changed_fields").$type<string[]>(),
    actor: jsonb("actor").$type<AuditActor>().notNull().default({ type: "unknown" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("entry_versions_entry_idx").on(t.entryId, t.createdAt)],
);

/**
 * One row per committed `transact` batch that carried an idempotencyKey. Written
 * as the FIRST statement inside the transaction with the complete per-op result
 * ids (all known before execution), so a retried batch replays the stored
 * results instead of re-applying — and a rolled-back batch leaves no receipt.
 */
export const transactReceipts = pgTable(
  "transact_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    results: jsonb("results").$type<{ op: string; collection: string; id: string }[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("transact_receipts_key_idx").on(t.projectId, t.idempotencyKey)],
);

/** A job's lifecycle. Only `pending` rows are claimable; the rest are terminal
 * except `running`, which a stale-lease reclaim can return to `pending`. */
export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";

/**
 * The shared job queue — one boring pg table drained by POST /api/jobs/drain.
 * Claimed with a single-statement FOR UPDATE SKIP LOCKED UPDATE (proven safe on
 * neon-http: concurrent drains partition work with zero coordination). Jobs are
 * MUTABLE intent (claimed/rescheduled); webhook_deliveries stays the immutable
 * outcome log. Only declarative features enqueue jobs — never arbitrary code.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text("dedupe_key"),
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    status: text("status").$type<JobStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("jobs_status_run_at_idx").on(t.status, t.runAt),
    // Suppress duplicate IN-FLIGHT work per project+kind. Covers BOTH pending and
    // running (not just pending): if it covered only pending, a duplicate could be
    // enqueued while the original is running, then the original's running→pending
    // reschedule (finishJob / reclaimStale) would collide → unique_violation and a
    // wedged queue. Scoped by project_id so one tenant can't suppress another's job.
    uniqueIndex("jobs_dedupe_idx")
      .on(t.projectId, t.kind, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL AND status IN ('pending', 'running')`),
  ],
);

/**
 * Recurrence presets — no cron strings (self-describing enums, zod-validated).
 * v1 is UTC-only: `timezone` is accepted but must be "UTC" (IANA zones + their
 * DST edge cases are a later increment). dayOfMonth caps at 28 so every month
 * has the day. `at` defaults to "00:00"; hourly fires at the top of each hour.
 */
export interface ScheduleRecurrence {
  frequency: "hourly" | "daily" | "weekly" | "monthly";
  /** "HH:MM" 24h UTC (daily/weekly/monthly). */
  at?: string;
  /** Required for weekly. */
  weekday?: "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
  /** Required for monthly; 1..28. */
  dayOfMonth?: number;
  /** v1: must be "UTC" when present. */
  timezone?: string;
}

/** A schedule's action — the same webhook/email vocabulary as entry events,
 * but without `when`/`after` (there is no entry to evaluate against). */
export type ScheduleAction =
  | { type: "webhook"; url: string }
  | { type: "email"; to: string; subject: string };

/**
 * Recurring schedules (G3), ticked by the drain endpoint: due rows CAS-advance
 * nextRunAt and only the advance WINNER enqueues the dedupeKey'd `schedule_fire`
 * job (overlapping drains can't double-fire a window). Fires are at-least-once
 * and may run up to a scheduler granularity (~1 min) late; missed windows fire
 * ONCE, never backfill.
 */
export const projectSchedules = pgTable(
  "project_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    recurrence: jsonb("recurrence").$type<ScheduleRecurrence>().notNull(),
    action: jsonb("action").$type<ScheduleAction>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("project_schedules_name_idx").on(t.projectId, t.name),
    index("project_schedules_due_idx").on(t.enabled, t.nextRunAt),
  ],
);

/**
 * Write-time visibility of a change-feed row — the "then" half of the read-time
 * intersection gate (H). Broadening a collection's visibility later can never
 * retroactively expose history: a row is served only if it passed BOTH the
 * visibility captured here AND the collection's CURRENT rules.
 */
export interface ChangeVis {
  /** publicRead field names at write time. */
  fields: string[];
  /** did the snapshot match publicFilter at write time. */
  pf: boolean;
  /** did prevData match publicFilter at write time (plain updates only). */
  prevPf?: boolean;
  /** access.read mode at write time. */
  read: ReadPreset;
  /** ownerField at write time (owner-gated collections). */
  ownerField?: string;
  /** org row scope at write time (F3). Captured here so removing an org scope
   *  later can't retroactively expose historical org-scoped rows through the
   *  feed — the org dimension of the then-AND-now intersection gate (H2). */
  org?: { claim: string; field: string };
}

export type ChangeKind = "created" | "updated" | "deleted";

/**
 * Append-only change feed (H1). Written INLINE (not deferred) by every mutation
 * path right after the entry write, so a sync cursor never loses a row to a
 * crash. `seq` (bigserial) is the monotone cursor key; `collectionId` is a PLAIN
 * uuid (NO FK) so feed rows can OUTLIVE a collection delete — which lets H3 append
 * per-entry tombstones on delete instead of cascading the history away (H3 adds
 * that; today a collection delete leaves its feed rows orphaned). `vis` captures
 * write-time visibility for H2's then-AND-now read gate.
 */
export const entryChanges = pgTable(
  "entry_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id").notNull(),
    collectionName: text("collection_name").notNull(),
    entryId: uuid("entry_id").notNull(),
    kind: text("kind").$type<ChangeKind>().notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    prevData: jsonb("prev_data").$type<Record<string, unknown>>(),
    changedFields: jsonb("changed_fields").$type<string[]>(),
    vis: jsonb("vis").$type<ChangeVis>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("entry_changes_project_seq_idx").on(t.projectId, t.seq),
    index("entry_changes_collection_seq_idx").on(t.collectionId, t.seq),
    // Supports the retention prune (DELETE older than 30 days) without a seq-scan.
    index("entry_changes_project_created_idx").on(t.projectId, t.createdAt),
  ],
);

export interface Branding {
  displayName?: string;
  logoUrl?: string;
  primaryColor?: string;
}

export type Project = InferSelectModel<typeof projects>;
export type Collection = InferSelectModel<typeof collections>;
export type Entry = InferSelectModel<typeof entries>;
export type Asset = InferSelectModel<typeof assets>;
export type ProjectToken = InferSelectModel<typeof projectTokens>;
export type ProjectMember = InferSelectModel<typeof projectMembers>;
export type ProjectConnector = InferSelectModel<typeof projectConnectors>;
export type WebhookDelivery = InferSelectModel<typeof webhookDeliveries>;
export type AuditLogRow = InferSelectModel<typeof auditLog>;
export type TransactReceipt = InferSelectModel<typeof transactReceipts>;
export type Job = InferSelectModel<typeof jobs>;
export type ProjectSchedule = InferSelectModel<typeof projectSchedules>;
export type EntryChange = InferSelectModel<typeof entryChanges>;
export type TrashedEntry = InferSelectModel<typeof entriesTrash>;
export type EntryVersion = InferSelectModel<typeof entryVersions>;
