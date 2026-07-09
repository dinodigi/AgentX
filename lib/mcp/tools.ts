import { z } from "zod";
import { accessSchema } from "@/lib/access-rules";
import { FIELD_TYPE_SPECS, COMMON_FIELD_CONFIG } from "@/lib/field-types";
import {
  getCollection,
  listCollections,
  defineCollection,
  planDeleteCollection,
  deleteCollection,
} from "@/lib/collections";
import {
  createEntry,
  updateEntry,
  deleteEntry,
  getEntry,
  countEntries,
  bulkCreateEntries,
  queryEntriesPage,
  resolveRefsForRead,
  expandRelations,
  includeReverse,
  collectRelatedTargets,
  validateSelect,
  projectData,
  encodeCursor,
  decodeCursor,
  aggregateEntries,
  updateEntryIf,
  transact,
  TransactError,
  restoreEntryVersion,
  ValidationError,
} from "@/lib/entries";
import { restoreEntry, listTrash, purgeEntry, emptyTrash } from "@/lib/trash";
import { listEntryVersions } from "@/lib/versions";
import { searchEntriesPage, searchableFields } from "@/lib/search";
import { getProject } from "@/lib/admin";
import { listAssets, deleteAsset } from "@/lib/r2";
import { listDeliveries } from "@/lib/webhook";
import { refireDelivery } from "@/lib/events";
import { listAuditLog } from "@/lib/audit";
import { listJobs, cancelJob } from "@/lib/jobs";
import { listChanges, encodeChangeCursor, decodeChangeCursor } from "@/lib/changes";
import { defineSchedule, listSchedules, deleteSchedule } from "@/lib/schedules";
import { generateClientCode } from "@/lib/mcp/client-code";
import { getAuthConfig, listConnectors as listConnectorRows } from "@/lib/connectors";
import { uploadAsset } from "@/lib/r2";
import { exportProject, importProject } from "@/lib/manifest";
import { exportEntries } from "@/lib/export";
import { formatZodError, issuesFromZod, type ConstraintIssue } from "@/lib/validation";
import type { ErrorCode } from "@/lib/error-codes";

/**
 * The MCP tool surface. Terse on purpose — the brief values terseness over
 * completeness. Every description states the system's boundaries out loud so
 * the AI never hunts for tools that don't exist.
 */

const BOUNDARIES =
  "Boundaries: this system defines DATA STRUCTURE + CRUD (plus atomic batches via " +
  "transact, recoverable deletes via trash/restore, delayed/scheduled actions, and " +
  "declarative field-transition workflows — actor-gated state machines with " +
  "webhook/email actions, no arbitrary code and no multi-entry orchestration). It " +
  "does NOT do authorization/row-level rules beyond presets (those live in the app " +
  "layer) or i18n. Public-read visibility is per-field (set publicRead on each field). " +
  "Public-write is per-collection.";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** JSON schema for one where clause — the single source for every where-shaped input. */
const WHERE_CLAUSE_JSON = {
  type: "object",
  properties: {
    field: {
      type: "string",
      description:
        'field name, or "relationField.targetField" (one hop) to filter by a related record\'s ' +
        "field — ops are type-checked against the target field; on MCP the target is read like " +
        "any MCP read (publicFilter/access do not apply)",
    },
    op: { type: "string", enum: ["eq", "contains", "gt", "lt", "in"] },
    value: { description: "scalar, or string[] for op 'in'" },
  },
  required: ["field", "op", "value"],
  additionalProperties: false,
} as const;

/** A where item: a clause, or {anyOf:[clauses]} — an OR group, one level only. */
const WHERE_ITEM_JSON = {
  oneOf: [
    WHERE_CLAUSE_JSON,
    {
      type: "object",
      properties: { anyOf: { type: "array", items: WHERE_CLAUSE_JSON, minItems: 1 } },
      required: ["anyOf"],
      additionalProperties: false,
    },
  ],
} as const;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "get_project_info",
    description:
      "Call this FIRST in a fresh session. Returns the project's name/branding and every " +
      "URL you need: the delivery API base (how the live site reads/writes content), the " +
      "admin URL (hand to the client), and the MCP endpoint. Pair with list_collections " +
      "to fully orient yourself.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_connectors",
    description:
      "Status of the project's BYO-infra connectors (clerk = end-user auth, resend = email " +
      "actions, stripe = payments). Returns type, status, and non-secret config (issuer, " +
      "publishable key, from address). Secrets (sk_/whsec_ keys) NEVER appear here — connecting/" +
      "rotating them is done by the operator in project settings, not over MCP.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_field_types",
    description:
      "List the 8 field primitives you may compose collections from (text, richtext, " +
      "number, boolean, date, enum, asset, relation) and each one's config. You must " +
      `only use these types. ${BOUNDARIES}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "define_collection",
    description:
      "Create or update a collection (a data model). `fields` is an array of field " +
      "defs, each: {name, label, type, required?, publicRead?} plus constraints " +
      "(unique? on text/number/date — DB-enforced, dates stored normalized to UTC ISO; " +
      "min/max? = value bounds on number, LENGTH bounds on text/richtext, ISO-string instant " +
      "bounds on date; integer? on number; pattern? = JS-regex source on text, requires max <= 10000, " +
      "patternHint? = the failure message; requiredIf?: {field, equals} against a sibling enum) and " +
      "type-specific config (enum:options[], relation:{targetCollection,labelField}). " +
      "Instantly manageable in the admin; no per-project UI code. Public fields are served " +
      "by the delivery API (see get_project_info). Set publicWrite:true + webhookUrl for a form. " +
      "Redefining an existing collection with dropped/retyped fields returns a diff plan " +
      "and requires confirm:true (affected entries are counted, not silently orphaned). " +
      "Tightening a constraint on existing data applies immediately and returns " +
      "constraintWarnings[] (violation counts) — old rows stay readable, new writes must comply. " +
      "To RENAME a field, pass renames: [{from, to}] with the new name in fields — entry " +
      `data is backfilled, no confirm needed; without renames a rename is a destructive drop+add. ${BOUNDARIES}`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "snake_case slug, unique in the project" },
        displayName: { type: "string" },
        fields: { type: "array", items: { type: "object" } },
        publicWrite: { type: "boolean", description: "allow public POST submissions (forms)" },
        webhookUrl: { type: "string", description: "fired on public-write submissions" },
        publicFilter: {
          type: "array",
          description:
            "row visibility for delivery reads: only rows matching ALL items are publicly " +
            "served, e.g. [{field:'approved',op:'eq',value:true}]. Items may be OR groups " +
            "{anyOf:[clauses]}. May use private fields. Admin and MCP reads are unaffected.",
          items: WHERE_ITEM_JSON,
        },
        access: {
          type: "object",
          description:
            "identity rule presets for the delivery API (parameterized, not an expression language). " +
            "read: public|authenticated|owner|{claim,equals}. write: none|authenticated|owner|" +
            "{claim,equals}. Each may also be an ARRAY meaning any-of (e.g. write:[\"owner\", " +
            '{claim:"role",equals:"editor"}]). A {claim,equals:"x"|["x","y"]} rule matches when the ' +
            "verified JWT custom claim equals a value (fail-closed: absent/non-string never matches). " +
            "owner/authenticated need ownerField (a text field, auto-stamped from the JWT sub — never " +
            'client-set); claim rules don\'t. write:"owner" enables PATCH/DELETE of OWN rows; a matching ' +
            "claim-write is staff write (mutate ANY row). " +
            "org:{claim,field} scopes EVERY read/write to the user's org: field (a text field) is " +
            "stamped from the JWT claim on create and stripped from PATCH bodies; rows are invisible " +
            "to other orgs and to tokens lacking the claim (fail-closed 403). org can't combine with " +
            "read:'public' or anonymous writes. Requires the project's Clerk connector.",
          properties: {
            read: {
              description: "public|authenticated|owner|{claim,equals} or an array of those",
            },
            write: {
              description: "none|authenticated|owner|{claim,equals} or an array of those",
            },
            ownerField: { type: "string" },
            org: {
              type: "object",
              description: "org row scoping: {claim: JWT claim name, field: text field to scope by}",
              properties: { claim: { type: "string" }, field: { type: "string" } },
              required: ["claim", "field"],
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        events: {
          type: "object",
          description:
            "declarative actions on entry lifecycle: {created|updated|deleted: [{type:'webhook',url} " +
            "| {type:'email',to,subject}]}. Email needs the Resend connector; to/subject support " +
            "{{field}} interpolation from entry data. Any action takes when: [clauses] (same shape " +
            "as query where, evaluated against the post-change entry — e.g. fire only when " +
            "status='confirmed') and disabled: true (paused, kept in the schema). updated events " +
            "carry {previous, changedFields}. Add after: '45m'|'12h'|'3d' (1m..365d) to DEFER the " +
            "action: it is queued at emit time (timer starts at the FIRST matching event; later " +
            "updates do not reset it or queue a second send while one is pending), and at send time " +
            "the action is re-read from this config and `when` is re-evaluated against the CURRENT " +
            "entry — so disabling, removing, or editing an action also cancels its pending delayed " +
            "sends, and a deleted entry skips silently. Delayed sends omit previous/changedFields. " +
            "Pending ones are visible via list_jobs. All outcomes land in the delivery log " +
            "(get_deliveries); failed ones can be replayed with refire_delivery.",
          properties: {
            created: { type: "array", items: { type: "object" } },
            updated: { type: "array", items: { type: "object" } },
            deleted: { type: "array", items: { type: "object" } },
          },
          additionalProperties: false,
        },
        workflow: {
          type: "object",
          description:
            "declarative state machine over ONE enum field: {field, initial, transitions:[{from: " +
            "state|state[], to: state, actors?: (mcp|admin|delivery)[], actions?: [event action]}]}. " +
            "initial is enforced on EVERY create path (including bulk_create_entries and " +
            "public/delivery writes — an explicit non-initial value is rejected). The field then " +
            "moves ONLY via a declared transition; an illegal move is rejected with the allowed " +
            "targets, and a target no transition reaches from the current state conflicts. " +
            "Transitions are ACTOR-GATED — by default only mcp and admin may transition; add " +
            "'delivery' to a transition's actors to let end users drive it (e.g. an owner cancelling " +
            "their own request). NOTE: 'admin' includes client-role members in v1. Overlapping " +
            "(from,to) pairs are rejected at define time so every move resolves one transition. " +
            "A matched transition fires its actions as an entry.transitioned event (webhook/email, " +
            "immediate — `after` not supported on transitions). Omitting workflow on redefine removes it.",
          properties: {
            field: { type: "string", description: "an existing enum field" },
            initial: { type: "string", description: "one of the field's options" },
            transitions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { description: "state or state[]" },
                  to: { type: "string" },
                  actors: { type: "array", items: { type: "string", enum: ["mcp", "admin", "delivery"] } },
                  actions: { type: "array", items: { type: "object" } },
                },
                required: ["from", "to"],
                additionalProperties: false,
              },
            },
          },
          required: ["field", "initial", "transitions"],
          additionalProperties: false,
        },
        checkout: {
          type: "object",
          description:
            "declarative Stripe checkout: {priceField, successUrl, cancelUrl}. priceField names an " +
            "existing TEXT field holding a Stripe Price id (price_…) — what is sellable and at what " +
            "price is server-side content, never sent by the client (clients POST only entry ids + " +
            "quantities to /v1/checkout). Requires the Stripe connector and access.read:'public' (or " +
            "absent) — owner/authenticated collections cannot be sold; do member-only pricing in your " +
            "app layer via events. BOUNDARIES: payment-mode Checkout Sessions only; no subscriptions, " +
            "invoicing, or refunds (those live in your Stripe dashboard / app layer). Order status " +
            "'expired' covers both session expiry and async-payment failure in v1. FULFILLMENT: " +
            "declare events.updated with when:{field:<status>, equals:'paid'} on the ORDERS " +
            "collection to fire your webhook/email — it fires only when payment actually clears.",
          properties: {
            priceField: { type: "string" },
            successUrl: { type: "string", description: "https redirect after payment" },
            cancelUrl: { type: "string", description: "https redirect if the buyer cancels" },
            orders: {
              type: "object",
              description:
                "optional (K4): turn paid sessions into order-entry writes. `collection` is another " +
                "collection in THIS project; each `fields` value names a field on it. On payment the " +
                "webhook flips status pending→paid (and expired on failure/expiry). status MUST be an " +
                "enum with options pending, paid, expired; sessionId text; total number; customerEmail " +
                "text; items text/richtext. A pending order row is written at checkout time (before the " +
                "Stripe redirect) so nothing is lost if the buyer abandons.",
              properties: {
                collection: { type: "string" },
                fields: {
                  type: "object",
                  properties: {
                    status: { type: "string", description: "enum field (pending|paid|expired)" },
                    sessionId: { type: "string", description: "text field" },
                    total: { type: "string", description: "optional number field (human amount)" },
                    customerEmail: { type: "string", description: "optional text field" },
                    items: { type: "string", description: "optional text/richtext field — cart JSON snapshot" },
                  },
                  required: ["status", "sessionId"],
                  additionalProperties: false,
                },
              },
              required: ["collection", "fields"],
              additionalProperties: false,
            },
          },
          required: ["priceField", "successUrl", "cancelUrl"],
          additionalProperties: false,
        },
        renames: {
          type: "array",
          description:
            "declared field renames; data moves from → to (same type, to must be in fields)",
          items: {
            type: "object",
            properties: { from: { type: "string" }, to: { type: "string" } },
            required: ["from", "to"],
            additionalProperties: false,
          },
        },
        confirm: { type: "boolean", description: "required to apply destructive schema changes" },
      },
      required: ["name", "fields"],
      additionalProperties: false,
    },
  },
  {
    name: "list_collections",
    description:
      "List every collection in this project (name, displayName, publicWrite, field count). " +
      "Call this first in a fresh session to discover what exists; use describe_collection for field detail.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_collection",
    description:
      "Return one collection's full field definitions and flags. Constraints " +
      "(min/max/pattern/enum/integer/unique) are enforced on WRITE only — rows that " +
      "predate a tightened constraint keep their stored values.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_collection",
    description:
      "Delete a collection AND all its entries. Without confirm:true this only returns " +
      "the impact plan (entry count, inbound relations). Blocked while other collections " +
      "have relation fields targeting it — remove those fields first.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        confirm: { type: "boolean", description: "must be true to actually delete" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "create_entry",
    description:
      "Create one entry in a collection. `data` is validated strictly against the " +
      "collection's schema — unknown fields, wrong types, bad enum values, and dangling " +
      "relation/asset ids are rejected. Pass idempotencyKey to make retries safe: a " +
      "repeated call with the same key returns the original entry instead of duplicating. CRUD only.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        data: { type: "object" },
        idempotencyKey: { type: "string" },
      },
      required: ["collection", "data"],
      additionalProperties: false,
    },
  },
  {
    name: "update_entry",
    description:
      "Partially update one entry by id. Provided fields are validated and merged. " +
      "Set a field to null to UNSET it (remove the key) — required fields reject null.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        id: { type: "string" },
        data: { type: "object" },
      },
      required: ["collection", "id", "data"],
      additionalProperties: false,
    },
  },
  {
    name: "update_entry_if",
    description:
      "Atomic compare-and-set on one entry — conditions and change apply in ONE statement, so " +
      "concurrent writers can't race between check and write. if: same clause shape as " +
      "query_entries where, checked against the CURRENT row. data: ordinary validated patch " +
      "(null = unset, like update_entry). " +
      "increment: {field, by} computes new = old + by IN SQL (never read-modify-write); the " +
      "field's min/max constraints guard the result automatically (integer fields also require " +
      "a whole `by`, and a stored value that predates the integer knob conflicts rather than " +
      "incrementing). A no-op returns a diagnosed failure: E_NOT_FOUND (no such entry), or " +
      "E_CONFLICT whose message names the cause — an if-clause that didn't hold, the increment " +
      "field being unset, or the increment breaching min/max. Re-read and retry. Book-a-seat: " +
      '{if:[{field:"seats",op:"gt",value:0}], increment:{field:"seats",by:-1}}.',
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        id: { type: "string" },
        if: { type: "array", items: WHERE_ITEM_JSON },
        data: { type: "object" },
        increment: {
          type: "object",
          properties: {
            field: { type: "string", description: "number field" },
            by: { type: "number", description: "delta; negative to decrement" },
          },
          required: ["field", "by"],
          additionalProperties: false,
        },
      },
      required: ["collection", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_entry",
    description:
      "Delete one entry by id. Moves it to TRASH — recoverable via restore_entry " +
      "(~30 days); permanent removal ships as purge_entry. Delivery reads and queries " +
      "exclude trashed rows immediately.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        id: { type: "string" },
      },
      required: ["collection", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_trash",
    description:
      "List trashed (soft-deleted) entries across the project, newest-deleted first. " +
      "Each row: {id, collection, data, deletedAt, deletedBy}. Page with before=<deletedAt cursor>. " +
      "Trashed rows auto-purge after ~30 days; restore_entry recovers them until then.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "1-100, default 50" },
        before: { type: "string", description: "ISO deletedAt cursor from a previous page" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "restore_entry",
    description:
      "Restore a trashed entry to its collection by id (within the ~30-day retention window). " +
      "Returns the same id. Re-emits an entry.created event carrying {restored:true, deletedAt} — " +
      "the restored entry keeps its ORIGINAL createdAt, so consumers polling by createdAt may need " +
      "a full resync to see it. Fails if the idempotency key was reused by a new create while trashed.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        id: { type: "string" },
      },
      required: ["collection", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "purge_entry",
    description:
      "Permanently remove ONE trashed entry — restore is no longer possible after this. " +
      "Without confirm:true returns a plan {inboundRefCount (entries that reference it and would " +
      "dangle), assetsFreed (assets that become deletable)} and code E_CONFIRM_REQUIRED. Trash " +
      "auto-purges after ~30 days regardless.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        id: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["collection", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "empty_trash",
    description:
      "Permanently remove ALL trashed entries, optionally scoped to one collection. Without " +
      "confirm:true returns a plan {count} and code E_CONFIRM_REQUIRED. Irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "optional: limit to one collection" },
        confirm: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_entry_versions",
    description:
      "PRE-image snapshots of an entry, newest first. Captured on update_entry, update_entry_if, " +
      "and admin edits; capped at the last 20 per entry. Each: {versionId, createdAt, actor, " +
      "changedFields, data}. Restore one with restore_entry_version.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        id: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["collection", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "restore_entry_version",
    description:
      "Roll an entry back to a past version by versionId. The snapshot is re-validated against " +
      "the CURRENT schema — an incompatible old snapshot (since-dropped/added fields) is rejected. " +
      "The pre-restore state is captured as a new version, so this is itself undoable. The entry " +
      "must be live (restore_entry it from trash first).",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        id: { type: "string" },
        versionId: { type: "string" },
      },
      required: ["collection", "id", "versionId"],
      additionalProperties: false,
    },
  },
  {
    name: "transact",
    description:
      "Apply up to 25 entry ops as ONE all-or-nothing batch (a single DB transaction). ops: " +
      "[{op:'create',collection,data} | {op:'update',collection,id,data} | {op:'delete',collection,id}]. " +
      "Every op is validated and ref-checked before anything runs; if any op fails (validation, a " +
      "unique conflict, or an update/delete hitting no row) NOTHING is applied and the error names " +
      "the failing op index. Stricter than delete_entry: a delete op on a missing id ABORTS the batch " +
      "(not a silent no-op). Events and the audit log fire only after commit, in op order. " +
      "ENTRY ops only — no schema/definition ops. MCP-only (not on the delivery API). " +
      "Cross-op refs: a create op may set ref:'order'; a LATER op references its new id as " +
      "\"$ref:order\" — either as a relation-field value or as its own id. Refs may only point to " +
      "EARLIER create ops, and a relation using $ref must target that ref's collection. The " +
      "$ref sentinel is only interpreted in relation fields and id positions (literal elsewhere). " +
      "An update_if op does an atomic compare-and-set inside the batch (same if/data/increment as " +
      "update_entry_if) — e.g. decrement seats AND create the booking together, all-or-nothing. " +
      "dryRun:true validates every op (collections, $refs, schema) and returns the plan WITHOUT " +
      "writing; it cannot pre-check an update_if race (conditions run only at execute time). " +
      "Pass idempotencyKey to make retries safe: a replayed batch returns the original result ids " +
      "with replayed:true and applies nothing twice (a rolled-back batch does NOT consume the key, " +
      "so retry after fixing the data). Without a key, a timeout AFTER commit is indistinguishable " +
      "from failure — re-query state before retrying. Returns {applied:true, results:[{op,collection,id}]}. " +
      'Example: [{op:"create",collection:"orders",data:{...},ref:"order"},' +
      '{op:"create",collection:"line_items",data:{order:"$ref:order",qty:2}}].',
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "validate + return the plan, write nothing" },
        idempotencyKey: { type: "string", description: "makes a retried batch safe (replayed:true)" },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: 25,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["create", "update", "delete", "update_if"] },
              collection: { type: "string" },
              id: { type: "string", description: "required for update/delete/update_if; may be \"$ref:<name>\"" },
              data: { type: "object", description: "required for create/update; optional for update_if" },
              ref: { type: "string", description: "create only: name this op for later \"$ref:<name>\"" },
              if: { type: "array", items: WHERE_ITEM_JSON, description: "update_if only: CAS conditions" },
              increment: {
                type: "object",
                description: "update_if only: atomic {field, by} increment",
                properties: { field: { type: "string" }, by: { type: "number" } },
                required: ["field", "by"],
                additionalProperties: false,
              },
            },
            required: ["op", "collection"],
            additionalProperties: false,
          },
        },
      },
      required: ["ops"],
      additionalProperties: false,
    },
  },
  {
    name: "query_entries",
    description:
      "List entries in a collection (relations resolved to {id,label}). Supports limit/offset " +
      "(default 100, max 500), where filters [{field, op: eq|contains|gt|lt|in, value}] and orderBy " +
      "{field, dir: asc|desc}. Ops are type-checked: contains=text/richtext, gt/lt=number/date, " +
      "in=text/enum/relation with value: string[]. Where items AND together; an item may be an OR " +
      "group {anyOf: [clauses]} (one level, no nesting). select: [fields] trims each entry's data " +
      "to those fields (id always included). expand: [relationField] replaces those relation values " +
      "with {id, label, data} — the full target record (depth 1), killing the N+1 round-trip. " +
      "Returns {entries, limit, offset, hasMore, nextOffset, nextCursor} — page with offset: " +
      "nextOffset, or (preferred for deep/chronological paging) pass cursor: nextCursor, which " +
      "uses the stable default ordering and stays exact past thousands of rows. cursor excludes " +
      "offset/orderBy. No full-text search service.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
        cursor: { type: "string", description: "nextCursor from a previous page" },
        where: { type: "array", items: WHERE_ITEM_JSON },
        select: { type: "array", items: { type: "string" } },
        expand: {
          type: "array",
          items: { type: "string" },
          description: "relation fields to expand to {id, label, data} (depth 1)",
        },
        includeReverse: {
          type: "array",
          maxItems: 3,
          description:
            "embed children that point back at each entry: [{collection, field, limit?}] where " +
            "field is a relation on `collection` targeting this one. Attached per entry as " +
            "related:{'collection.field':{entries,hasMore}} (capped, default 20/max 100 per parent; " +
            "page deeper via a direct query_entries where field eq parentId).",
          items: {
            type: "object",
            properties: {
              collection: { type: "string" },
              field: { type: "string" },
              limit: { type: "number" },
            },
            required: ["collection", "field"],
            additionalProperties: false,
          },
        },
        orderBy: {
          type: "object",
          properties: {
            field: { type: "string" },
            dir: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["field", "dir"],
          additionalProperties: false,
        },
      },
      required: ["collection"],
      additionalProperties: false,
    },
  },
  {
    name: "get_entry",
    description:
      "Fetch one entry by id (relations → {id,label}, assets → {id,url}). expand: [relationField] " +
      "expands those to {id, label, data} — the full target record (depth 1).",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        id: { type: "string" },
        expand: { type: "array", items: { type: "string" }, description: "relation fields to expand" },
      },
      required: ["collection", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "search_entries",
    description:
      "Keyword full-text search over every field marked searchable:true (INCLUDING non-public " +
      "ones — MCP is trusted). websearch syntax (quoted phrases, OR, -exclude). Results are " +
      "rank-ordered (best first); offset paging only. Optional where filters (same shape as " +
      "query_entries) narrow the set. Not semantic/vector search. Errors if the collection has " +
      "no searchable fields.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        q: { type: "string", description: "search query (websearch syntax, 1-500 chars)" },
        where: { type: "array", items: WHERE_ITEM_JSON },
        select: { type: "array", items: { type: "string" } },
        limit: { type: "number", description: "default 20, max 100" },
        offset: { type: "number" },
      },
      required: ["collection", "q"],
      additionalProperties: false,
    },
  },
  {
    name: "count_entries",
    description: "Count entries in a collection, optionally with the same where filters as query_entries.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        where: { type: "array", items: WHERE_ITEM_JSON },
      },
      required: ["collection"],
      additionalProperties: false,
    },
  },
  {
    name: "aggregate_entries",
    description:
      "Aggregate a collection WITHOUT fetching rows — dashboards in one query. aggregates: " +
      "[{fn: count|sum|avg|min|max, field?}] (count takes no field; the rest need a number " +
      "field). Optional groupBy on an enum or relation field (relation groups include the " +
      "target's label). Same where vocabulary as query_entries (eq/contains/gt/lt/in + anyOf). " +
      "Groups are capped at 500, largest first, with truncatedGroups: true when cut. " +
      "Example: revenue by trip = {aggregates:[{fn:'sum',field:'price'}], groupBy:'trip'}.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        aggregates: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              fn: { type: "string", enum: ["count", "sum", "avg", "min", "max"] },
              field: { type: "string", description: "number field; omit for count" },
            },
            required: ["fn"],
            additionalProperties: false,
          },
        },
        groupBy: { type: "string", description: "enum or relation field" },
        where: { type: "array", items: WHERE_ITEM_JSON },
      },
      required: ["collection", "aggregates"],
      additionalProperties: false,
    },
  },
  {
    name: "bulk_create_entries",
    description:
      "Create up to 100 entries in one call (use for seeding). Each item is validated like " +
      "create_entry; returns per-item results so you can fix only the failures.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        entries: { type: "array", items: { type: "object" }, maxItems: 100 },
      },
      required: ["collection", "entries"],
      additionalProperties: false,
    },
  },
  {
    name: "list_assets",
    description:
      "List uploaded assets (id, filename, contentType, size, url). Supports limit/offset " +
      "(default 100, max 500); returns {assets, limit, offset, hasMore, nextOffset}. Raster " +
      "images support on-demand resizing at GET /v1/assets/{id}/image?w=&h=&format= (see " +
      "get_project_info deliveryApi.images).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        offset: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "delete_asset",
    description:
      "Delete an uploaded asset (file + record). Blocked while entries still reference it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "export_entries",
    description:
      "Export a collection's entry DATA (raw values — relations/assets stay ids so mappings " +
      "survive re-import). json or csv, capped at 5000 rows with a truncated flag. Pairs with " +
      "export_project (schema) for full portability/backup.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        format: { type: "string", enum: ["json", "csv"] },
      },
      required: ["collection"],
      additionalProperties: false,
    },
  },
  {
    name: "export_project",
    description:
      "Export the entire project definition (branding + all collections) as one JSON " +
      "manifest. Version it in git, diff it, or replicate the project elsewhere via " +
      "import_project. Entries and secrets are not included.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "import_project",
    description:
      "Apply a manifest (from export_project) to THIS project. Idempotent — unchanged " +
      "collections are no-ops. Destructive schema changes return plans and need confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        manifest: { type: "object", description: "a version-1 project manifest" },
        confirm: { type: "boolean", description: "apply destructive schema changes" },
      },
      required: ["manifest"],
      additionalProperties: false,
    },
  },
  {
    name: "get_deliveries",
    description:
      "Read the project's event delivery log (webhooks + emails, newest first) to debug your " +
      "own event wiring — no human needed. Email rows have url \"email:<to>\". Optional filters: " +
      "collection (slug), status (success|failed), event (e.g. entry.created). Supports " +
      "limit/offset (default 20, max 200); returns {deliveries, limit, offset, hasMore, nextOffset}.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        status: { type: "string", enum: ["success", "failed"] },
        event: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_client_code",
    description:
      "Generate a typed, dependency-free TypeScript client for this project's delivery API " +
      "from the live schema — use it in the site instead of hand-rolling fetch calls. " +
      "Per-collection types + list/get/create/update/remove (each generated only where the " +
      "schema allows it), delivery-token and X-User-Token handling built in. Save the returned " +
      "code as a file (e.g. lib/agentx.ts) and RE-CALL THIS TOOL after any define_collection " +
      "change — the client is a snapshot of the schema.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "refire_delivery",
    description:
      "Replay a delivery from the log (see get_deliveries for ids). Webhooks re-post the stored " +
      "payload with a fresh retry cycle; emails re-send the stored render. The outcome lands in " +
      "the log as a NEW row — the original stays as history. Returns the replay's status.",
    inputSchema: {
      type: "object",
      properties: { deliveryId: { type: "string" } },
      required: ["deliveryId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_audit_log",
    description:
      "Read the entry audit trail (newest first): who changed what, from which surface. Each " +
      "row: {entryId, collection, action: create|update|delete, actor: {type: mcp|admin|delivery, " +
      "userId?}, changedFields, createdAt}. Optional filters: collection (slug), entryId, action. " +
      "Supports limit/offset (default 20, max 200); returns {audit, limit, offset, hasMore, nextOffset}.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        entryId: { type: "string" },
        action: { type: "string", enum: ["create", "update", "delete", "restore", "purge"] },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_jobs",
    description:
      "List background jobs for this project, newest first. Jobs are created ONLY by declarative " +
      "features (delayed event actions, schedules) and drained by the platform's cron — there is no " +
      "arbitrary-code path. Each row: {id, kind, status: pending|running|succeeded|failed|canceled, " +
      "runAt, attempts, maxAttempts, lastError, dedupeKey, payload, createdAt}. Optional filters: " +
      "kind, status. Supports limit/offset (default 20, max 100); returns {jobs, limit, offset, hasMore, nextOffset}.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        status: { type: "string", enum: ["pending", "running", "succeeded", "failed", "canceled"] },
        limit: { type: "number", description: "1-100, default 20" },
        offset: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_changes",
    description:
      "Read the append-only change feed (created/updated/deleted, oldest-first) for near-realtime " +
      "sync. Each row: {cursor, collection, id, kind, at, changedFields, data (full snapshot), " +
      "prevData (plain/CAS updates)}. Pass since=<cursor from a previous page> to get only newer " +
      "changes; omit it to read from the beginning. Returns {changes, cursor, hasMore}. THIS TOOL " +
      "IS FULL-TRUST — it shows ALL fields; the delivery endpoint GET /v1/changes applies the " +
      "write-time-AND-current publicRead/publicFilter intersection. Retention ~30 days; refs are " +
      "raw uuids (re-fetch for labels). A field RENAME invalidates older snapshots — reconcile with " +
      "a full list after one.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "filter to one collection (optional)" },
        since: { type: "string", description: "opaque cursor from a previous response" },
        limit: { type: "number", description: "1-500, default 100" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cancel_job",
    description:
      "Cancel ONE pending background job by id (from list_jobs) — the per-job override. " +
      "Only pending jobs cancel; a running/succeeded/failed/canceled job returns E_CONFLICT. " +
      "For delayed event actions, the DECLARATIVE kill switch is disabling or removing the " +
      "action itself in define_collection events — that skips ALL its queued sends at run time.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "define_schedule",
    description:
      "Create or update (upsert by name) a recurring schedule that fires a webhook or email — " +
      "presets only, no cron strings. recurrence: {frequency: hourly|daily|weekly|monthly, " +
      "at: 'HH:MM' (24h UTC; not for hourly — hourly fires at the top of each hour), weekday " +
      "(weekly), dayOfMonth 1-28 (monthly; capped so every month has the day)}. UTC-only for now. " +
      "action: {type:'webhook',url} | {type:'email',to,subject} — the same vocabulary as events " +
      "but WITHOUT when/after (the recurrence is the timing; email supports {{name}}/" +
      "{{scheduledFor}}). Fires are at-least-once (receivers must dedupe) and may run up to a " +
      "minute late; a missed window fires once, never backfills. enabled:false pauses the " +
      "schedule AND skips its already-queued fires. Outcomes land in get_deliveries as " +
      "schedule.fired; pending fires show in list_jobs.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "slug, unique per project — upsert key" },
        recurrence: {
          type: "object",
          properties: {
            frequency: { type: "string", enum: ["hourly", "daily", "weekly", "monthly"] },
            at: { type: "string", description: '"HH:MM" 24h UTC (daily/weekly/monthly; default "00:00")' },
            weekday: {
              type: "string",
              enum: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
            },
            dayOfMonth: { type: "number", description: "1-28 (monthly)" },
            timezone: { type: "string", description: 'must be "UTC" when present (v1)' },
          },
          required: ["frequency"],
          additionalProperties: false,
        },
        action: { type: "object", description: "{type:'webhook',url} | {type:'email',to,subject}" },
        enabled: { type: "boolean", description: "false = paused (kept, not ticked); default true" },
      },
      required: ["name", "recurrence", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "list_schedules",
    description:
      "List this project's recurring schedules: {name, recurrence, action, enabled, nextRunAt, lastRunAt}.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "delete_schedule",
    description:
      "Delete a schedule by name. Returns the full deleted spec so it can be re-created with " +
      "define_schedule (the reversibility story). To PAUSE instead, define_schedule with " +
      "enabled:false — that also skips already-queued fires.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "upload_asset",
    description:
      "Upload a file and get back an asset id to store in an `asset` field. Provide bytes " +
      "as base64. Stored in object storage; a URL is returned for preview.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string" },
        contentType: { type: "string" },
        dataBase64: { type: "string", description: "file bytes, base64-encoded" },
      },
      required: ["filename", "contentType", "dataBase64"],
      additionalProperties: false,
    },
  },
];

const whereClauseSchema = z.object({
  field: z.string(),
  op: z.enum(["eq", "contains", "gt", "lt", "in"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});
const whereItemSchema = z.union([
  whereClauseSchema,
  z.object({ anyOf: z.array(whereClauseSchema).min(1) }),
]);

const eventActionBase = {
  when: z.array(whereItemSchema).optional(),
  disabled: z.boolean().optional(),
  after: z
    .string()
    .regex(/^\d+(m|h|d)$/, 'after must be "<n>m" | "<n>h" | "<n>d", e.g. "3d"')
    .optional(),
};
const eventActionSchema = z.union([
  z.object({ type: z.literal("webhook"), url: z.string(), ...eventActionBase }),
  z.object({ type: z.literal("email"), to: z.string(), subject: z.string(), ...eventActionBase }),
]);

const defineArgs = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  fields: z.array(z.any()),
  publicWrite: z.boolean().optional(),
  webhookUrl: z.string().url().optional(),
  publicFilter: z.array(whereItemSchema).optional(),
  access: accessSchema.optional(),
  events: z
    .object({
      created: z.array(eventActionSchema).optional(),
      updated: z.array(eventActionSchema).optional(),
      deleted: z.array(eventActionSchema).optional(),
    })
    .optional(),
  renames: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  workflow: z
    .object({
      field: z.string(),
      initial: z.string(),
      transitions: z
        .array(
          z.object({
            from: z.union([z.string(), z.array(z.string()).min(1)]),
            to: z.string(),
            actors: z.array(z.enum(["mcp", "admin", "delivery"])).optional(),
            actions: z.array(eventActionSchema).optional(),
          }),
        )
        .min(1),
    })
    .nullable()
    .optional(),
  checkout: z
    .object({
      priceField: z.string(),
      successUrl: z.string(),
      cancelUrl: z.string(),
      orders: z
        .object({
          collection: z.string(),
          fields: z.object({
            status: z.string(),
            sessionId: z.string(),
            total: z.string().optional(),
            customerEmail: z.string().optional(),
            items: z.string().optional(),
          }),
        })
        .optional(),
    })
    .nullable()
    .optional(),
  confirm: z.boolean().optional(),
});
const nameArg = z.object({ name: z.string() });
const createArgs = z.object({
  collection: z.string(),
  data: z.record(z.unknown()),
  idempotencyKey: z.string().min(1).optional(),
});
const updateArgs = z.object({
  collection: z.string(),
  id: z.string(),
  data: z.record(z.unknown()),
});
const queryArgs = z.object({
  collection: z.string(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  where: z.array(whereItemSchema).optional(),
  select: z.array(z.string()).optional(),
  expand: z.array(z.string()).optional(),
  includeReverse: z
    .array(z.object({ collection: z.string(), field: z.string(), limit: z.number().optional() }))
    .max(3)
    .optional(),
  cursor: z.string().optional(),
  orderBy: z
    .object({ field: z.string(), dir: z.enum(["asc", "desc"]) })
    .optional(),
});
const uploadArgs = z.object({
  filename: z.string(),
  contentType: z.string(),
  dataBase64: z.string(),
});

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function err(message: string, code: ErrorCode, issues?: ConstraintIssue[]): ToolResult {
  // Line 1 stays `Error [CODE]: message` (agents already parse it); the issues
  // block is an additive machine-readable mirror, capped so a bulk payload of
  // violations can't flood the transcript.
  const text =
    `Error [${code}]: ${message}` +
    (issues && issues.length > 0 ? `\nissues: ${JSON.stringify(issues.slice(0, 20))}` : "");
  return { content: [{ type: "text", text }], isError: true };
}

async function mustCollection(projectId: string, name: string) {
  const c = await getCollection(projectId, name);
  if (!c) throw new ValidationError(`collection "${name}" not found`, "E_NOT_FOUND");
  return c;
}

/** Dispatch a tool call for a resolved project. Never throws — returns ToolResult. */
export interface ToolContext {
  /** Origin of the incoming request, e.g. http://localhost:3000 */
  baseUrl: string;
}

export async function callTool(
  projectId: string,
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_connectors": {
        const rows = await listConnectorRows(projectId);
        return ok(
          rows.map((c) => ({ type: c.type, status: c.status, config: c.config })),
        );
      }

      case "get_project_info": {
        const [project, authConfig, connectorRows] = await Promise.all([
          getProject(projectId),
          getAuthConfig(projectId),
          listConnectorRows(projectId),
        ]);
        if (!project) return err("project not found", "E_NOT_FOUND");
        return ok({
          project: {
            name: project.name,
            branding: project.branding,
          },
          urls: {
            deliveryBase: `${ctx.baseUrl}/api/v1`,
            admin: `${ctx.baseUrl}/admin/${projectId}`,
            mcp: `${ctx.baseUrl}/api/mcp`,
            changes: `${ctx.baseUrl}/api/v1/changes`,
            changesStream: `${ctx.baseUrl}/api/v1/changes/stream`,
            stripeWebhook: `${ctx.baseUrl}/api/stripe/webhook/${projectId}`,
          },
          stripe: (() => {
            const s = connectorRows.find((c) => c.type === "stripe");
            return {
              // configured = the sk is connected → /v1/checkout can create sessions.
              configured: Boolean(s),
              // Non-secret publishable key — site builders embed it in the storefront (K6).
              publishableKey: s?.config.publishableKey ?? null,
              // K5: true when a signing secret is stored (one-click provisioned OR
              // manually pasted) — the real "paid orders will flip" signal. Keyed
              // on the whsec slot, not the endpoint id, so it can't read true while
              // the webhook still 503s for lack of a secret.
              webhookProvisioned: Boolean(s?.secretsEnc?.webhookSigning),
            };
          })(),
          stripeWebhookHint:
            "For paid orders to flip, the webhook must be registered. EASIEST: the operator clicks " +
            "'Provision webhook' on the Stripe connector card — it registers urls.stripeWebhook and " +
            "stores the whsec_ signing secret automatically (stripe.webhookProvisioned then true). " +
            "MANUAL alternative: register urls.stripeWebhook in the Stripe dashboard for " +
            "checkout.session.{completed,expired,async_payment_succeeded,async_payment_failed} and " +
            "paste its whsec_ secret on the card. The signature is the endpoint's only auth — without " +
            "it the webhook answers 503.",
          deliveryApi: {
            auth: "Authorization: Bearer <project token> on every request",
            read:
              "GET {deliveryBase}/{collection} — returns ONLY publicRead fields; " +
              "relations resolve to {id,label}, assets to {id,url}; " +
              "filters: ?field=value (public fields, equality); sort: ?sort=field:asc|desc; " +
              "projection: ?select=a,b (public fields, id always included); " +
              "pagination: ?limit=&offset=. " +
              "?expand=relField expands a public relation to {id,label,data} (target must be " +
              "publicly readable; its row visibility applies). " +
              "?relField.targetField=value filters by a related record's public field (target " +
              "row visibility applies). " +
              "?include=child.relField embeds a public child collection's rows that point back " +
              "(both the child and its back-reference field must be public). " +
              "?q=terms full-text search over public searchable fields, rank-ordered (websearch " +
              "syntax), rate-limited. Same params on GET {deliveryBase}/{collection}/{id}.",
            write:
              "POST {deliveryBase}/{collection} — anonymous when publicWrite, or " +
              "authenticated per access rules; validated like create_entry; fires events",
            uploads:
              "POST {deliveryBase}/{collection}/uploads — multipart/form-data 'file' part; " +
              "same gates as write plus the collection needs an asset field; returns {id,url} " +
              "to reference in the submission. 10 MB / image, pdf, text, csv, json only.",
            checkout:
              "POST {deliveryBase}/checkout — turn a cart into a Stripe Checkout Session for a " +
              "collection with checkout config. Body {collection, items:[{id, quantity 1..100}], " +
              "successUrl?, cancelUrl?} — the client sends ONLY entry ids + quantities; Price ids/" +
              "amounts are server-side (the collection's priceField). Returns 201 {url, sessionId} — " +
              "redirect the buyer to url. Same read gate as a public GET (a missing/hidden item and an " +
              "absent one give one indistinguishable 422). URL overrides must share the configured " +
              "origin. Stripe rejection → 502 {code:E_UPSTREAM} with Stripe's reason. Payment-mode " +
              "only. Fulfillment: declare events.updated when status=paid (K4) — it fires only when " +
              "payment actually clears.",
            images:
              "GET {deliveryBase}/assets/{id}/image?w=&h=&fit=&format= — on-demand resize of a " +
              "raster image asset, 302 to a 1-year-immutable R2 URL (NO auth header — directly " +
              "embeddable in <img>/srcset). w/h are ints 16..2000, snapped up to " +
              "[64,96,128,256,320,480,640,768,960,1200,1600,2000]; at least one required. " +
              "format webp (default) | jpeg. fit cover|inside ONLY when both w and h are given " +
              "(otherwise 422). Up to 40 distinct derivatives per asset, then 429 " +
              "{code:E_RATE_LIMITED} (reuse a variant). Non-image or svg asset → 422. " +
              "resolved asset fields include contentType so you know when this applies.",
            realtime:
              "PULL, not push: GET {deliveryBase}/changes?since=<cursor> returns changes " +
              "(created|updated|deleted) since the cursor — omit since to get {changes:[], cursor} " +
              "and stream forward; ETag 304 when idle. Or consume GET {deliveryBase}/changes/stream " +
              "(SSE, bounded lifetime — reconnect with ?since or Last-Event-ID; the poll endpoint is " +
              "the guaranteed-everywhere floor). Same publicRead/publicFilter/identity gating as a " +
              "direct read, intersected with WRITE-TIME visibility so broadening a rule never exposes " +
              "history. A hidden→shown row arrives as created/updated (upsert on unknown id); a " +
              "shown→hidden row and a delete arrive as kind:deleted; refs are raw uuids. On a gap, a " +
              "whole-collection delete, or a field rename, do a full list GET to reconcile. Push to " +
              "YOUR server stays events:{webhook} on define_collection.",
            conventions:
              "errors are {error, code} with stable E_* codes; GETs carry ETags " +
              "(send If-None-Match, get 304)",
            userAuth:
              "collections with access rules need the end-user's JWT in the X-User-Token " +
              "header (issued by the project's connected Clerk instance). " +
              'write:"owner" also enables PATCH/DELETE {deliveryBase}/{collection}/{id}.',
          },
          endUserAuth: authConfig
            ? { configured: true, issuer: authConfig.issuer }
            : { configured: false, hint: "connect Clerk in project settings to use access rules" },
          connectors: connectorRows.map((c) => ({ type: c.type, status: c.status })),
        });
      }
      case "list_field_types":
        return ok({ commonConfig: COMMON_FIELD_CONFIG, types: FIELD_TYPE_SPECS });

      case "define_collection": {
        const a = defineArgs.parse(rawArgs);
        const result = await defineCollection(projectId, {
          name: a.name,
          displayName: a.displayName,
          fields: a.fields as never,
          publicWrite: a.publicWrite,
          webhookUrl: a.webhookUrl,
          publicFilter: a.publicFilter,
          access: a.access,
          events: a.events,
          workflow: a.workflow as never,
          checkout: a.checkout as never,
          renames: a.renames,
          confirm: a.confirm,
        });
        if (!result.applied) {
          return ok({
            requiresConfirmation: true,
            code: "E_CONFIRM_REQUIRED",
            plan: result.diff,
            hint: result.hint,
          });
        }
        return ok({
          ok: true,
          collection: result.collection.name,
          fields: result.collection.fields.length,
          ...(result.diff ? { changes: result.diff } : {}),
          ...(result.constraintWarnings ? { constraintWarnings: result.constraintWarnings } : {}),
        });
      }

      case "list_collections": {
        const all = await listCollections(projectId);
        return ok(
          all.map((c) => ({
            name: c.name,
            displayName: c.displayName,
            publicWrite: c.publicWrite,
            fieldCount: c.fields.length,
          })),
        );
      }

      case "describe_collection": {
        const a = nameArg.parse(rawArgs);
        const c = await mustCollection(projectId, a.name);
        return ok({
          name: c.name,
          displayName: c.displayName,
          publicWrite: c.publicWrite,
          webhookUrl: c.webhookUrl,
          publicFilter: c.publicFilter ?? null,
          access: c.access ?? null,
          events: c.events ?? null,
          workflow: c.workflow ?? null,
          checkout: c.checkout ?? null,
          fields: c.fields,
        });
      }

      case "delete_collection": {
        const a = z
          .object({ name: z.string(), confirm: z.boolean().optional() })
          .parse(rawArgs);
        const plan = await planDeleteCollection(projectId, a.name);
        if (!plan) return err(`collection "${a.name}" not found`, "E_NOT_FOUND");
        if (plan.inboundRelations.length > 0) {
          return err(
            `blocked: relation fields still target "${a.name}": ` +
              plan.inboundRelations.map((r) => `${r.collection}.${r.field}`).join(", ") +
              ". Redefine those collections without these fields first.",
            "E_BLOCKED",
          );
        }
        if (!a.confirm) {
          return ok({
            requiresConfirmation: true,
            code: "E_CONFIRM_REQUIRED",
            plan: {
              wouldDeleteEntries: plan.entryCount,
              trashedEntries: plan.trashedEntries,
              changeFeedTombstones: plan.changeFeedTombstones,
            },
            hint:
              `re-run with confirm: true to delete permanently. ${plan.changeFeedTombstones} tombstone ` +
              "rows will be appended to the change feed so synced clients converge.",
          });
        }
        await deleteCollection(projectId, a.name);
        return ok({ deleted: a.name, entriesDeleted: plan.entryCount });
      }

      case "create_entry": {
        const a = createArgs.parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const e = await createEntry(projectId, c, a.data, {
          idempotencyKey: a.idempotencyKey,
          actor: { type: "mcp" },
        });
        return ok({ id: e.id, data: e.data });
      }

      case "update_entry": {
        const a = updateArgs.parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const e = await updateEntry(projectId, c, a.id, a.data, { type: "mcp" });
        return ok({ id: e.id, data: e.data });
      }

      case "update_entry_if": {
        const a = z
          .object({
            collection: z.string(),
            id: z.string(),
            if: z.array(whereItemSchema).optional(),
            data: z.record(z.unknown()).optional(),
            increment: z.object({ field: z.string(), by: z.number() }).optional(),
          })
          .parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const result = await updateEntryIf(projectId, c, a.id, {
          if: a.if,
          data: a.data,
          increment: a.increment,
          actor: { type: "mcp" },
        });
        if (!result.ok) {
          if (result.reason === "not_found") {
            return err(`no entry ${a.id} in "${a.collection}"`, "E_NOT_FOUND");
          }
          // conflict | unset | bounds all keep E_CONFLICT (code stability) but
          // carry the guard-specific diagnosis so an agent can repair precisely.
          return err(
            result.message ??
              "condition not met — re-read the entry and retry",
            "E_CONFLICT",
          );
        }
        return ok({ id: result.entry.id, data: result.entry.data });
      }

      case "delete_entry": {
        const a = updateArgs.omit({ data: true }).parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        await deleteEntry(c, a.id, { type: "mcp" });
        return ok({ deleted: a.id });
      }

      case "list_trash": {
        const a = z
          .object({ limit: z.number().optional(), before: z.string().optional() })
          .parse(rawArgs);
        return ok(await listTrash(projectId, a));
      }

      case "restore_entry": {
        const a = z.object({ collection: z.string(), id: z.string() }).parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const restored = await restoreEntry(projectId, c, a.id, { type: "mcp" });
        return ok({ id: restored.id, restored: true });
      }

      case "purge_entry": {
        const a = z
          .object({ collection: z.string(), id: z.string(), confirm: z.boolean().optional() })
          .parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const r = await purgeEntry(projectId, c, a.id, { confirm: a.confirm, actor: { type: "mcp" } });
        if (!r.purged) {
          return ok({ requiresConfirmation: true, code: "E_CONFIRM_REQUIRED", plan: r.plan, hint: r.hint });
        }
        return ok({ purged: true, id: r.id });
      }

      case "empty_trash": {
        const a = z
          .object({ collection: z.string().optional(), confirm: z.boolean().optional() })
          .parse(rawArgs);
        const c = a.collection ? await mustCollection(projectId, a.collection) : undefined;
        const r = await emptyTrash(projectId, { collection: c, confirm: a.confirm, actor: { type: "mcp" } });
        if (!r.emptied) {
          return ok({ requiresConfirmation: true, code: "E_CONFIRM_REQUIRED", plan: r.plan, hint: r.hint });
        }
        return ok({ emptied: true, purged: r.purged });
      }

      case "list_entry_versions": {
        const a = z
          .object({
            collection: z.string(),
            id: z.string(),
            limit: z.number().optional(),
            offset: z.number().optional(),
          })
          .parse(rawArgs);
        await mustCollection(projectId, a.collection);
        return ok(await listEntryVersions(projectId, a.id, { limit: a.limit, offset: a.offset }));
      }

      case "restore_entry_version": {
        const a = z
          .object({ collection: z.string(), id: z.string(), versionId: z.string() })
          .parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const entry = await restoreEntryVersion(projectId, c, a.id, a.versionId, { type: "mcp" });
        return ok({ id: entry.id, data: entry.data });
      }

      case "transact": {
        const a = z
          .object({
            dryRun: z.boolean().optional(),
            idempotencyKey: z.string().optional(),
            ops: z
              .array(
                z.object({
                  op: z.enum(["create", "update", "delete", "update_if"]),
                  collection: z.string(),
                  id: z.string().optional(),
                  data: z.record(z.unknown()).optional(),
                  ref: z.string().optional(),
                  if: z.array(whereItemSchema).optional(),
                  increment: z.object({ field: z.string(), by: z.number() }).optional(),
                }),
              )
              .min(1)
              .max(25),
          })
          .parse(rawArgs);
        try {
          const outcome = await transact(projectId, a.ops, { type: "mcp" }, {
            dryRun: a.dryRun,
            idempotencyKey: a.idempotencyKey,
          });
          return ok(outcome);
        } catch (e) {
          if (e instanceof TransactError) {
            return err(
              `op[${e.opIndex}] ${e.message}; transaction rolled back — no ops applied`,
              e.code,
            );
          }
          throw e;
        }
      }

      case "query_entries": {
        const a = queryArgs.parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        if (a.select) validateSelect(c.fields, a.select);
        if (a.cursor !== undefined && a.offset !== undefined) {
          return err(
            "pass either cursor or offset, not both — cursor supersedes offset paging",
            "E_VALIDATION",
          );
        }
        const related = await collectRelatedTargets(projectId, c, a.where ?? [], "mcp");
        const page = await queryEntriesPage(c, {
          limit: a.limit,
          offset: a.offset,
          where: a.where,
          orderBy: a.orderBy,
          after: a.cursor !== undefined ? decodeCursor(a.cursor) : undefined,
          related,
        });
        // Project before resolving refs so unselected relations cost nothing.
        const rows = a.select
          ? page.rows.map((r) => ({ ...r, data: projectData(r.data, a.select!) }))
          : page.rows;
        if (a.expand) await expandRelations(projectId, c, rows, a.expand, "full", "trusted");
        const resolved = await resolveRefsForRead(projectId, c, rows, "trusted");
        const reverse = a.includeReverse
          ? await includeReverse(projectId, c, resolved.map((r) => r.id), a.includeReverse, "full", "trusted")
          : undefined;
        const last = page.rows[page.rows.length - 1];
        return ok({
          entries: resolved.map((r) => ({
            id: r.id,
            data: r.data,
            ...(reverse?.get(r.id) ? { related: reverse.get(r.id) } : {}),
          })),
          limit: page.limit,
          hasMore: page.hasMore,
          // Offset paging (breaks past a few thousand rows)…
          ...(a.cursor === undefined
            ? { offset: page.offset, nextOffset: page.hasMore ? page.offset + page.limit : null }
            : {}),
          // …and keyset paging over the default ordering (always exact).
          ...(a.orderBy === undefined
            ? { nextCursor: page.hasMore && last ? encodeCursor(last) : null }
            : {}),
        });
      }

      case "search_entries": {
        const a = z
          .object({
            collection: z.string(),
            q: z.string(),
            where: z.array(whereItemSchema).optional(),
            select: z.array(z.string()).optional(),
            limit: z.number().optional(),
            offset: z.number().optional(),
          })
          .parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        if (a.select) validateSelect(c.fields, a.select);
        const page = await searchEntriesPage(c, {
          q: a.q,
          fields: searchableFields(c.fields),
          where: a.where,
          limit: a.limit,
          offset: a.offset,
        });
        const rows = a.select
          ? page.rows.map((r) => ({ ...r, data: projectData(r.data, a.select!) }))
          : page.rows;
        const resolved = await resolveRefsForRead(projectId, c, rows, "trusted");
        return ok({
          entries: resolved.map((r) => ({
            id: r.id,
            rank: (r as unknown as { rank: number }).rank,
            data: r.data,
          })),
          limit: page.limit,
          offset: page.offset,
          hasMore: page.hasMore,
          nextOffset: page.hasMore ? page.offset + page.limit : null,
        });
      }

      case "get_entry": {
        const a = z
          .object({
            collection: z.string(),
            id: z.string(),
            expand: z.array(z.string()).optional(),
            includeReverse: z
              .array(z.object({ collection: z.string(), field: z.string(), limit: z.number().optional() }))
              .max(3)
              .optional(),
          })
          .parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const row = await getEntry(c, a.id);
        if (!row) return err(`no entry ${a.id} in "${a.collection}"`, "E_NOT_FOUND");
        if (a.expand) await expandRelations(projectId, c, [row], a.expand, "full", "trusted");
        const [resolved] = await resolveRefsForRead(projectId, c, [row], "trusted");
        const reverse = a.includeReverse
          ? await includeReverse(projectId, c, [resolved.id], a.includeReverse, "full", "trusted")
          : undefined;
        return ok({
          id: resolved.id,
          data: resolved.data,
          ...(reverse?.get(resolved.id) ? { related: reverse.get(resolved.id) } : {}),
        });
      }

      case "count_entries": {
        const a = queryArgs
          .omit({ limit: true, offset: true, orderBy: true, select: true, cursor: true })
          .parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const relatedC = await collectRelatedTargets(projectId, c, a.where ?? [], "mcp");
        return ok({ count: await countEntries(c, a.where ?? [], relatedC) });
      }

      case "aggregate_entries": {
        const a = z
          .object({
            collection: z.string(),
            aggregates: z
              .array(
                z.object({
                  fn: z.enum(["count", "sum", "avg", "min", "max"]),
                  field: z.string().optional(),
                }),
              )
              .min(1)
              .max(10),
            groupBy: z.string().optional(),
            where: z.array(whereItemSchema).optional(),
          })
          .parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const relatedA = await collectRelatedTargets(projectId, c, a.where ?? [], "mcp");
        const result = await aggregateEntries(c, {
          aggregates: a.aggregates,
          groupBy: a.groupBy,
          where: a.where,
          related: relatedA,
        });
        const shape = (values: (number | null)[]) =>
          a.aggregates.map((spec, i) => ({
            fn: spec.fn,
            ...(spec.field ? { field: spec.field } : {}),
            value: values[i],
          }));
        if (!a.groupBy) {
          return ok({ results: shape(result.groups[0].values) });
        }
        return ok({
          groupBy: a.groupBy,
          groups: result.groups.map((g) => ({
            key: g.key,
            ...(g.label !== undefined ? { label: g.label } : {}),
            results: shape(g.values),
          })),
          truncatedGroups: result.truncated,
        });
      }

      case "bulk_create_entries": {
        const a = z
          .object({ collection: z.string(), entries: z.array(z.record(z.unknown())).max(100) })
          .parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const results = await bulkCreateEntries(projectId, c, a.entries, { type: "mcp" });
        const created = results.filter((r) => r.ok).length;
        return ok({ created, failed: results.length - created, results });
      }

      case "list_assets": {
        const a = z
          .object({ limit: z.number().optional(), offset: z.number().optional() })
          .parse(rawArgs ?? {});
        const limit = Math.max(1, Math.min(a.limit ?? 100, 500));
        const offset = Math.max(0, a.offset ?? 0);
        const rows = await listAssets(projectId, { limit: limit + 1, offset });
        const hasMore = rows.length > limit;
        return ok({
          assets: rows.slice(0, limit).map((r) => ({
            id: r.id,
            filename: r.filename,
            contentType: r.contentType,
            size: Number(r.size),
            url: r.url,
          })),
          limit,
          offset,
          hasMore,
          nextOffset: hasMore ? offset + limit : null,
        });
      }

      case "delete_asset": {
        const a = z.object({ id: z.string() }).parse(rawArgs);
        await deleteAsset(projectId, a.id);
        return ok({ deleted: a.id });
      }

      case "export_entries": {
        const a = z
          .object({ collection: z.string(), format: z.enum(["json", "csv"]).optional() })
          .parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        return ok(await exportEntries(c, a.format ?? "json"));
      }

      case "export_project":
        return ok(await exportProject(projectId));

      case "import_project": {
        const a = z
          .object({ manifest: z.record(z.unknown()), confirm: z.boolean().optional() })
          .parse(rawArgs);
        const result = await importProject(projectId, a.manifest, a.confirm ?? false);
        if (result.pendingPlans.length > 0) {
          return ok({ ...result, code: "E_CONFIRM_REQUIRED" });
        }
        return ok(result);
      }

      case "get_deliveries": {
        const a = z
          .object({
            collection: z.string().optional(),
            status: z.enum(["success", "failed"]).optional(),
            event: z.string().optional(),
            limit: z.number().optional(),
            offset: z.number().optional(),
          })
          .parse(rawArgs ?? {});
        const limit = Math.max(1, Math.min(a.limit ?? 20, 200));
        const offset = Math.max(0, a.offset ?? 0);
        const collectionId = a.collection
          ? (await mustCollection(projectId, a.collection)).id
          : undefined;
        const rows = await listDeliveries(projectId, {
          collectionId,
          status: a.status,
          event: a.event,
          limit,
          offset,
        });
        const hasMore = rows.length > limit;
        return ok({
          deliveries: rows.slice(0, limit).map((r) => ({
            id: r.id,
            event: r.event,
            url: r.url,
            status: r.status,
            attempts: Number(r.attempts),
            lastError: r.lastError,
            payload: r.payload,
            createdAt: r.createdAt,
          })),
          limit,
          offset,
          hasMore,
          nextOffset: hasMore ? offset + limit : null,
        });
      }

      case "get_client_code": {
        const [project, all] = await Promise.all([
          getProject(projectId),
          listCollections(projectId),
        ]);
        if (!project) return err("project not found", "E_NOT_FOUND");
        if (all.length === 0) {
          return err(
            "no collections defined yet — define_collection first, then generate the client",
            "E_NOT_FOUND",
          );
        }
        const generated = generateClientCode({
          projectName: project.name,
          deliveryBase: `${ctx.baseUrl}/api/v1`,
          collections: all,
        });
        return ok({
          filename: "agentx.ts",
          language: "typescript",
          collections: generated.collections,
          ...(generated.skipped.length
            ? {
                skipped: generated.skipped,
                skippedReason:
                  "no public fields and no write access — nothing a delivery client could do",
              }
            : {}),
          code: generated.code,
        });
      }

      case "refire_delivery": {
        const a = z.object({ deliveryId: z.string() }).parse(rawArgs);
        const status = await refireDelivery(projectId, a.deliveryId);
        return ok({ refired: true, status });
      }

      case "get_audit_log": {
        const a = z
          .object({
            collection: z.string().optional(),
            entryId: z.string().optional(),
            action: z.enum(["create", "update", "delete", "restore", "purge"]).optional(),
            limit: z.number().optional(),
            offset: z.number().optional(),
          })
          .parse(rawArgs ?? {});
        const limit = Math.max(1, Math.min(a.limit ?? 20, 200));
        const offset = Math.max(0, a.offset ?? 0);
        // Audit rows key on the collection slug (they outlive the collection),
        // so an unknown slug is not an error — it just matches nothing.
        const rows = await listAuditLog(projectId, {
          collectionName: a.collection,
          entryId: a.entryId,
          action: a.action,
          limit,
          offset,
        });
        const hasMore = rows.length > limit;
        return ok({
          audit: rows.slice(0, limit).map((r) => ({
            entryId: r.entryId,
            collection: r.collectionName,
            action: r.action,
            actor: r.actor,
            changedFields: r.changedFields,
            createdAt: r.createdAt,
          })),
          limit,
          offset,
          hasMore,
          nextOffset: hasMore ? offset + limit : null,
        });
      }

      case "upload_asset": {
        const a = uploadArgs.parse(rawArgs);
        const asset = await uploadAsset({
          projectId,
          filename: a.filename,
          contentType: a.contentType,
          bytes: Buffer.from(a.dataBase64, "base64"),
        });
        return ok({ id: asset.id, url: asset.url });
      }

      case "list_jobs": {
        const a = z
          .object({
            kind: z.string().optional(),
            status: z.enum(["pending", "running", "succeeded", "failed", "canceled"]).optional(),
            limit: z.number().optional(),
            offset: z.number().optional(),
          })
          .parse(rawArgs);
        const limit = Math.min(Math.max(a.limit ?? 20, 1), 100);
        const offset = Math.max(a.offset ?? 0, 0);
        const { jobs: rows, hasMore } = await listJobs(projectId, { kind: a.kind, status: a.status, limit, offset });
        return ok({
          jobs: rows.map((j) => ({
            id: j.id,
            kind: j.kind,
            status: j.status,
            runAt: j.runAt,
            attempts: j.attempts,
            maxAttempts: j.maxAttempts,
            lastError: j.lastError,
            dedupeKey: j.dedupeKey,
            payload: j.payload,
            createdAt: j.createdAt,
          })),
          limit,
          offset,
          hasMore,
          nextOffset: hasMore ? offset + limit : null,
        });
      }

      case "get_changes": {
        const a = z
          .object({
            collection: z.string().optional(),
            since: z.string().optional(),
            limit: z.number().optional(),
          })
          .parse(rawArgs);
        const collectionId = a.collection ? (await mustCollection(projectId, a.collection)).id : undefined;
        const since = a.since !== undefined ? decodeChangeCursor(a.since) : undefined;
        const { changes, hasMore, cursor } = await listChanges(projectId, {
          since,
          collectionId,
          limit: a.limit,
        });
        return ok({
          changes: changes.map((c) => ({
            cursor: encodeChangeCursor(Number(c.seq)),
            collection: c.collectionName,
            id: c.entryId,
            kind: c.kind,
            at: c.createdAt,
            changedFields: c.changedFields,
            data: c.data,
            ...(c.prevData ? { prevData: c.prevData } : {}),
          })),
          cursor: encodeChangeCursor(cursor),
          hasMore,
        });
      }

      case "cancel_job": {
        const a = z.object({ id: z.string() }).parse(rawArgs);
        const r = await cancelJob(projectId, a.id);
        if (!r.ok) {
          if (r.reason === "not_found") {
            return err(`no job ${a.id} in this project — list_jobs shows what exists`, "E_NOT_FOUND");
          }
          return err(`job already ${r.status} — only pending jobs can be canceled`, "E_CONFLICT");
        }
        return ok({ id: r.job.id, kind: r.job.kind, status: r.job.status });
      }

      case "define_schedule": {
        const a = z
          .object({
            name: z.string(),
            recurrence: z.record(z.unknown()),
            action: z.record(z.unknown()),
            enabled: z.boolean().optional(),
          })
          .parse(rawArgs);
        // Deep validation (recurrence presets, action vocabulary, connector
        // requirements) lives in defineSchedule — one definition of valid.
        const row = await defineSchedule(projectId, {
          name: a.name,
          recurrence: a.recurrence as never,
          action: a.action as never,
          enabled: a.enabled,
        });
        return ok({
          name: row.name,
          recurrence: row.recurrence,
          action: row.action,
          enabled: row.enabled,
          nextRunAt: row.nextRunAt,
        });
      }

      case "list_schedules": {
        const rows = await listSchedules(projectId);
        return ok(
          rows.map((s) => ({
            name: s.name,
            recurrence: s.recurrence,
            action: s.action,
            enabled: s.enabled,
            nextRunAt: s.nextRunAt,
            lastRunAt: s.lastRunAt,
          })),
        );
      }

      case "delete_schedule": {
        const a = nameArg.parse(rawArgs);
        const deleted = await deleteSchedule(projectId, a.name);
        return ok({
          deleted: {
            name: deleted.name,
            recurrence: deleted.recurrence,
            action: deleted.action,
            enabled: deleted.enabled,
          },
          hint: "re-create it with define_schedule using this spec",
        });
      }

      default:
        return err(`unknown tool "${name}"`, "E_UNKNOWN_TOOL");
    }
  } catch (e) {
    if (e instanceof z.ZodError) return err(formatZodError(e), "E_VALIDATION", issuesFromZod(e, []));
    if (e instanceof ValidationError) return err(e.message, e.code, e.issues);
    return err(e instanceof Error ? e.message : String(e), "E_INTERNAL");
  }
}
