import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  bigserial,
  date,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
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
  | ({
      type: "email";
      to: string;
      subject: string;
      html?: string;
      /** 2a: custom sender — validated against the connector's approved senders
       * (fromEmail, its domain, or config.approvedSenders); never free-form. */
      from?: string;
      /** May interpolate {{field}} — the reply-to-submitter pattern. */
      replyTo?: string;
      cc?: string[];
      bcc?: string[];
    } & EventActionBase);

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
  /**
   * The workspace that OWNS this project (B1). Nullable only through the
   * migration window; app logic always sets it on create and it is the unit of
   * billing + the top rung of the access ladder. A project belongs to exactly
   * one workspace; sharing to outsiders is a project_members row, never a second
   * owner.
   */
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  /** Branding handed to the client: { displayName, logoUrl, primaryColor, ... } */
  branding: jsonb("branding").$type<Branding>().notNull().default({}),
  /** i18n locale registry {default, supported}; null = localized fields unavailable (J3). */
  locales: jsonb("locales").$type<ProjectLocales>(),
  /** v2 Track 1b: project-level block library — named BlockDefs materialized
   * into collections at define time ({ [name]: {label, fields} }). */
  blockLibrary: jsonb("block_library").$type<Record<string, { label: string; fields: FieldDef[] }>>(),
  /** Signs outgoing webhooks (X-AgentX-Signature); revealed to operators in settings. */
  webhookSigningSecret: text("webhook_signing_secret"),
  /** 2b inbound email: route a provider's parsed-inbound POST into a collection.
   * { collectionName, secretHash, fieldMap:{from?,to?,subject?,text?,html?} }; null = off. */
  inboundConfig: jsonb("inbound_config").$type<{
    collectionName: string;
    secretHash: string;
    fieldMap: Record<string, string>;
  }>(),
  /**
   * Lifecycle (B2): 'setup' = created but no data plane chosen yet — the admin
   * shows the setup surface and the MCP/delivery APIs stay dark; 'active' =
   * live. DB default 'active' keeps every pre-B2 row live with no backfill;
   * paid creates insert 'setup' explicitly. 'suspended' (B4) = the operator
   * abuse lever — MCP + delivery dark, admin stays reachable (banner), and
   * ONLY the console can flip it back (activateProject refuses).
   */
  status: text("status").$type<"setup" | "active" | "suspended">().notNull().default("active"),
  /**
   * Commercial plan (B2/B3): 'sandbox' = the workspace's one free, hard-capped,
   * shared-plane project; 'byo' | 'managed' = paid ($19/$29 anchors, billed in
   * B3). NULL = legacy/operator-era project — ungated, uncapped.
   */
  plan: text("plan").$type<"sandbox" | "byo" | "managed">(),
  /**
   * B3 platform billing (OUR Stripe — distinct from tenant stripe connectors).
   * NULL billingStatus = unbilled (sandbox/legacy/exempt). The webhook is the
   * only writer of 'active'/'past_due'/'canceled'.
   */
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  billingStatus: text("billing_status").$type<"active" | "past_due" | "canceled">(),
  /** Operator-created paid projects skip billing (ours/dogfood/support). */
  billingExempt: boolean("billing_exempt").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // C4: ONE free sandbox per workspace, enforced at the DB — the action's
  // count-then-insert check alone is raceable by concurrent creates.
  uniqueIndex("projects_one_sandbox_per_ws_idx")
    .on(t.workspaceId)
    .where(sql`plan = 'sandbox'`),
]);

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
    /** Which data-plane environment the token addresses (A1.3). Everything is
     * 'prod' until A5 mints per-env tokens and threads env through delivery. */
    env: text("env").$type<"prod" | "dev">().notNull().default("prod"),
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

/** A workspace role. owner = billing + delete + membership; admin = manage
 * projects + invite managers; manager = work in every workspace project. All
 * three cascade to `operator` at the project level (§B1). */
export type WorkspaceRole = "owner" | "admin" | "manager";

/**
 * A workspace owns projects and is the unit a customer signs up for and pays
 * per project within (B1). One user can belong to many workspaces
 * (workspace_members); a project belongs to exactly one workspace
 * (projects.workspaceId). This is the top rung of the access ladder above the
 * per-project sharing that project_members provides.
 */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Who belongs to a workspace and at what role. A membership here cascades to
 * every project the workspace owns — so an agency adds a teammate once, not
 * per project. Sharing a SINGLE project with an outsider stays a
 * project_members row (the client-handoff path).
 */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    email: text("email").notNull(),
    role: text("role").$type<WorkspaceRole>().notNull().default("manager"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("workspace_members_user_idx").on(t.workspaceId, t.clerkUserId)],
);

/**
 * Control-plane trail of PLATFORM-OPERATOR actions on tenant projects (B4):
 * suspend/unsuspend and support access. Distinct from the tenant-side
 * audit_log (entry mutations, tenant DB) — these rows are about us acting on
 * a tenant, so they live where the tenant cannot reach and survive project
 * deletion (FK SET NULL + name snapshot: an abuse trail must not be erasable
 * by deleting the project). Visible to the tenant in project Settings —
 * that visibility is the support-access policy, not a courtesy.
 */
export type PlatformEventType = "suspend" | "unsuspend" | "support_access";

export const platformEvents = pgTable(
  "platform_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** Snapshot — keeps the row readable after the project is deleted. */
    projectName: text("project_name").notNull(),
    type: text("type").$type<PlatformEventType>().notNull(),
    actorEmail: text("actor_email").notNull(),
    /** Suspend reason; shown to the tenant on the suspension banner. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("platform_events_project_idx").on(t.projectId, t.createdAt)],
);

export type PlatformEventRow = typeof platformEvents.$inferSelect;

/**
 * Durable rate-limit windows (C2): one row per (key, minute-window), counted
 * up by an atomic UPSERT on every limited request — survives restarts and is
 * shared across instances, which the old in-memory store was not. Rows live
 * minutes: the drain's rollup folds expired windows into usage_daily and
 * deletes them. `projectId` attributes the hit for metering (null = an
 * unattributable surface, e.g. global image-transform keys).
 */
export const rateWindows = pgTable(
  "rate_windows",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.windowStart] }),
    index("rate_windows_start_idx").on(t.windowStart),
  ],
);

/**
 * Per-project daily request counts (B3's deferred "request metering", riding
 * C2's store as planned): accumulated from expired rate windows by the drain
 * rollup. Counts LIMITED surfaces (writes, search, uploads, checkout,
 * transforms) — plain cached reads are deliberately unmetered to keep the hot
 * read path free of a control-plane write. Caps-not-metering still stands:
 * this is operator visibility, not billing.
 */
export const usageDaily = pgTable(
  "usage_daily",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.day] })],
);

/**
 * Track 4b: per-project Neon consumption snapshots — MANAGED data planes only
 * (BYO databases are the customer's cost). The Neon project object reports
 * CURRENT-billing-period totals, so one row per (project, day) holds the
 * latest snapshot that day; day-over-day deltas are computed at read time.
 * consumption_period_start detects period resets so a delta never goes
 * negative silently. Captured by the drain cron (lib/neon-usage.ts); feeds
 * the per-project stats surface (4c) and metered billing (4d).
 */
export const neonUsageDaily = pgTable(
  "neon_usage_daily",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    computeTimeSeconds: bigint("compute_time_seconds", { mode: "number" }).notNull().default(0),
    activeTimeSeconds: bigint("active_time_seconds", { mode: "number" }).notNull().default(0),
    writtenDataBytes: bigint("written_data_bytes", { mode: "number" }).notNull().default(0),
    dataStorageBytesHour: bigint("data_storage_bytes_hour", { mode: "number" }).notNull().default(0),
    /** Neon's storage-cost driver: logical size + history (bytes). */
    syntheticStorageSizeBytes: bigint("synthetic_storage_size_bytes", { mode: "number" }).notNull().default(0),
    /** Egress this period (bytes) — present on the project object (verified live). */
    dataTransferBytes: bigint("data_transfer_bytes", { mode: "number" }).notNull().default(0),
    consumptionPeriodStart: timestamp("consumption_period_start", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.day] })],
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

/**
 * Operator-editable platform configuration (key → jsonb), managed from the
 * console's Platform Settings page instead of env vars / code constants.
 * Known keys: "caps.sandbox" / "caps.paid" (partial overrides of the
 * lib/caps.ts defaults) and "meteredRates" (Track 4d — overrides METERED_RATES
 * env; absence of both keeps metered billing inert).
 */
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * DB-backed plugin catalog (Track 6 decision: client/per-project plugins must
 * never live in the platform binary). A row is a full PluginDef; project_id
 * NULL = platform-global (operator-authored), set = visible ONLY to that
 * project (authored via MCP define_plugin, always scoped to the caller).
 * Effective catalog = in-code built-ins + global rows + the project's rows.
 * Uniqueness via expression index (id, COALESCE(project_id, zero-uuid)).
 */
/**
 * The feedback wall: agents working ANY project report platform limitations/
 * friction via the always-available send_feedback MCP tool; the operator
 * console reads it in one place. project_id survives project deletion as NULL
 * (the signal outlives the tenant).
 */
export const platformFeedback = pgTable("platform_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id"),
  category: text("category").notNull(), // limitation | bug | friction | idea
  summary: text("summary").notNull(),
  detail: text("detail"),
  toolName: text("tool_name"),
  /** Receipts (guard): the exact request + verbatim response the reporter
   * observed. REQUIRED for category "bug" — enforced at the tool. */
  evidence: jsonb("evidence").$type<{ request: string; response: string; reproduction?: string }>(),
  /** Deterministic ingest checks: claimed E_* codes vs the registry, toolName
   * vs TOOL_DEFS, platform commit + enabled-plugin versions at filing time.
   * Badges make a report CHECKABLE — the repro still decides what's true. */
  verification: jsonb("verification").$type<{
    claimedCodes: string[];
    unknownCodes: string[];
    toolKnown: boolean | null;
    platform: string;
    plugins: string[];
  }>(),
  status: text("status").notNull().default("new"), // new | reviewed | planned | done | dismissed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pluginDefs = pgTable("plugin_defs", {
  id: text("id").notNull(),
  projectId: uuid("project_id"),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-project plugin enablement (Post-Deployment v1.0 Track 2). The catalog is
 * in-code (lib/plugins.ts PLUGIN_CATALOG); this table records which plugins a
 * project has enabled. Enabling unlocks the plugin's MCP tools and signals the
 * capability to the AI via list_plugins.
 */
export const projectPlugins = pgTable(
  "project_plugins",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.pluginId] })],
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
  // explicitWorkflowState: the migration escape hatch was used on this create
  // (feedback #12) — entries were loaded at explicit workflow states instead of
  // `initial`. Stamped by the MCP tool layer so imports are audit-traceable.
  | { type: "mcp"; explicitWorkflowState?: true }
  | { type: "admin"; userId?: string }
  | { type: "delivery"; userSub?: string }
  | { type: "inbound" } // 2b: an inbound-email → collection route (trusted, secret-gated)
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
 * CONTROL-PLANE pointer asset id → owning project (A2). The public image
 * transform URL (`/v1/assets/{id}/image`) carries no project context, and the
 * `assets` row itself lives in the owning project's tenant DB — this pointer
 * is how the route finds which data plane to look in without breaking every
 * embedded URL. Written on upload for every project (redundant-but-harmless
 * for fallback projects); cascades away with the project.
 */
export const assetPointers = pgTable("asset_pointers", {
  assetId: uuid("asset_id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
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
  | { type: "email"; to: string; subject: string; html?: string };

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
  /** Curated lucide icon key (Appearance tab) — see components/admin/project-icons. */
  icon?: string;
  /** Legacy: uploaded logo. Retired from the Appearance form; still rendered if set. */
  logoUrl?: string;
  primaryColor?: string;
  /** Admin register for this project's workspace: dark (default) | light. */
  theme?: "dark" | "light";
}

/**
 * Project-wide locale registry. `default` is the delivery fallback target and
 * must be in `supported`. Tags are stored normalized lowercase ("en", "pt-br").
 */
export interface ProjectLocales {
  default: string;
  supported: string[];
}

export type Project = InferSelectModel<typeof projects>;
export type Workspace = InferSelectModel<typeof workspaces>;
export type WorkspaceMember = InferSelectModel<typeof workspaceMembers>;
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
