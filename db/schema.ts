import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** An action fired by an entry event. Email requires the resend connector. */
export type EventAction =
  | { type: "webhook"; url: string }
  | { type: "email"; to: string; subject: string };
import type { FieldDef } from "@/lib/field-types";
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
    publicFilter: jsonb("public_filter").$type<
      { field: string; op: "eq" | "contains" | "gt" | "lt"; value: string | number | boolean }[]
    >(),
    /**
     * Identity rule presets for the delivery API (Phase 4). No expression
     * language — three fixed levels per direction. `owner` requires ownerField
     * to name a text field; it is auto-stamped from the verified JWT sub.
     */
    access: jsonb("access").$type<{
      read?: "public" | "authenticated" | "owner";
      write?: "none" | "authenticated" | "owner";
      ownerField?: string;
    }>(),
    /** Declarative event actions: on created/updated/deleted → webhook/email. */
    events: jsonb("events").$type<{
      created?: EventAction[];
      updated?: EventAction[];
      deleted?: EventAction[];
    }>(),
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
    collectionId: uuid("collection_id").notNull(),
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
