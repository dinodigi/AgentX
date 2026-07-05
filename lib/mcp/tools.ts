import { z } from "zod";
import { FIELD_TYPE_SPECS } from "@/lib/field-types";
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
  validateSelect,
  projectData,
  encodeCursor,
  decodeCursor,
  aggregateEntries,
  ValidationError,
} from "@/lib/entries";
import { getProject } from "@/lib/admin";
import { listAssets, deleteAsset } from "@/lib/r2";
import { listDeliveries } from "@/lib/webhook";
import { listAuditLog } from "@/lib/audit";
import { generateClientCode } from "@/lib/mcp/client-code";
import { getAuthConfig, listConnectors as listConnectorRows } from "@/lib/connectors";
import { uploadAsset } from "@/lib/r2";
import { exportProject, importProject } from "@/lib/manifest";
import { exportEntries } from "@/lib/export";
import { formatZodError } from "@/lib/validation";
import type { ErrorCode } from "@/lib/error-codes";

/**
 * The MCP tool surface. Terse on purpose — the brief values terseness over
 * completeness. Every description states the system's boundaries out loud so
 * the AI never hunts for tools that don't exist.
 */

const BOUNDARIES =
  "Boundaries: this system defines DATA STRUCTURE + CRUD only. It does NOT do " +
  "authorization/row-level rules (those live in the app layer), transactional/atomic " +
  "multi-step actions, versioning, i18n, or workflows. Public-read visibility is " +
  "per-field (set publicRead on each field). Public-write is per-collection.";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** JSON schema for one where clause — the single source for every where-shaped input. */
const WHERE_CLAUSE_JSON = {
  type: "object",
  properties: {
    field: { type: "string" },
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
      "actions). Returns type, status, and non-secret config (issuer, publishable key, from " +
      "address). Secrets NEVER appear here — connecting/rotating them is done by the operator " +
      "in project settings, not over MCP.",
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
      "defs, each: {name, label, type, required?, publicRead?} plus type-specific config " +
      "(enum:options[], relation:{targetCollection,labelField}). Instantly manageable in " +
      "the admin; no per-project UI code. Public fields are served by the delivery API " +
      "(see get_project_info). Set publicWrite:true + webhookUrl for a form. " +
      "Redefining an existing collection with dropped/retyped fields returns a diff plan " +
      `and requires confirm:true (affected entries are counted, not silently orphaned). ${BOUNDARIES}`,
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
            "identity rule presets for the delivery API. read: public|authenticated|owner; " +
            "write: none|authenticated|owner. owner/authenticated rules need ownerField (a text " +
            "field storing the end-user id, auto-stamped from the verified JWT — never client-set). " +
            'write:"owner" also enables PATCH/DELETE /v1/{collection}/{id} for own rows. ' +
            "Requires the project's Clerk connector. Complex authorization beyond these presets " +
            "stays in the app layer.",
          properties: {
            read: { type: "string", enum: ["public", "authenticated", "owner"] },
            write: { type: "string", enum: ["none", "authenticated", "owner"] },
            ownerField: { type: "string" },
          },
          additionalProperties: false,
        },
        events: {
          type: "object",
          description:
            "declarative actions on entry lifecycle: {created|updated|deleted: [{type:'webhook',url} " +
            "| {type:'email',to,subject}]}. Email needs the Resend connector; to/subject support " +
            "{{field}} interpolation from entry data. All outcomes land in the delivery log.",
          properties: {
            created: { type: "array", items: { type: "object" } },
            updated: { type: "array", items: { type: "object" } },
            deleted: { type: "array", items: { type: "object" } },
          },
          additionalProperties: false,
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
    description: "Return one collection's full field definitions and flags.",
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
    description: "Partially update one entry by id. Provided fields are validated and merged.",
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
    name: "delete_entry",
    description: "Delete one entry by id. Permanent — there is no versioning or trash.",
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
    name: "query_entries",
    description:
      "List entries in a collection (relations resolved to {id,label}). Supports limit/offset " +
      "(default 100, max 500), where filters [{field, op: eq|contains|gt|lt|in, value}] and orderBy " +
      "{field, dir: asc|desc}. Ops are type-checked: contains=text/richtext, gt/lt=number/date, " +
      "in=text/enum/relation with value: string[]. Where items AND together; an item may be an OR " +
      "group {anyOf: [clauses]} (one level, no nesting). select: [fields] trims each entry's data " +
      "to those fields (id always included). " +
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
    description: "Fetch one entry by id (relations → {id,label}, assets → {id,url}).",
    inputSchema: {
      type: "object",
      properties: { collection: { type: "string" }, id: { type: "string" } },
      required: ["collection", "id"],
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
      "(default 100, max 500); returns {assets, limit, offset, hasMore, nextOffset}.",
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
        action: { type: "string", enum: ["create", "update", "delete"] },
        limit: { type: "number" },
        offset: { type: "number" },
      },
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

const eventActionSchema = z.union([
  z.object({ type: z.literal("webhook"), url: z.string() }),
  z.object({ type: z.literal("email"), to: z.string(), subject: z.string() }),
]);

const whereClauseSchema = z.object({
  field: z.string(),
  op: z.enum(["eq", "contains", "gt", "lt", "in"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});
const whereItemSchema = z.union([
  whereClauseSchema,
  z.object({ anyOf: z.array(whereClauseSchema).min(1) }),
]);

const defineArgs = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  fields: z.array(z.any()),
  publicWrite: z.boolean().optional(),
  webhookUrl: z.string().url().optional(),
  publicFilter: z.array(whereItemSchema).optional(),
  access: z
    .object({
      read: z.enum(["public", "authenticated", "owner"]).optional(),
      write: z.enum(["none", "authenticated", "owner"]).optional(),
      ownerField: z.string().optional(),
    })
    .optional(),
  events: z
    .object({
      created: z.array(eventActionSchema).optional(),
      updated: z.array(eventActionSchema).optional(),
      deleted: z.array(eventActionSchema).optional(),
    })
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
function err(message: string, code: ErrorCode): ToolResult {
  return { content: [{ type: "text", text: `Error [${code}]: ${message}` }], isError: true };
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
          },
          deliveryApi: {
            auth: "Authorization: Bearer <project token> on every request",
            read:
              "GET {deliveryBase}/{collection} — returns ONLY publicRead fields; " +
              "relations resolve to {id,label}, assets to {id,url}; " +
              "filters: ?field=value (public fields, equality); sort: ?sort=field:asc|desc; " +
              "projection: ?select=a,b (public fields, id always included); " +
              "pagination: ?limit=&offset=",
            write:
              "POST {deliveryBase}/{collection} — anonymous when publicWrite, or " +
              "authenticated per access rules; validated like create_entry; fires events",
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
        return ok(FIELD_TYPE_SPECS);

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
            plan: { wouldDeleteEntries: plan.entryCount },
            hint: "re-run with confirm: true to delete permanently",
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

      case "delete_entry": {
        const a = updateArgs.omit({ data: true }).parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        await deleteEntry(c, a.id, { type: "mcp" });
        return ok({ deleted: a.id });
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
        const page = await queryEntriesPage(c, {
          limit: a.limit,
          offset: a.offset,
          where: a.where,
          orderBy: a.orderBy,
          after: a.cursor !== undefined ? decodeCursor(a.cursor) : undefined,
        });
        // Project before resolving refs so unselected relations cost nothing.
        const rows = a.select
          ? page.rows.map((r) => ({ ...r, data: projectData(r.data, a.select!) }))
          : page.rows;
        const resolved = await resolveRefsForRead(projectId, c, rows);
        const last = page.rows[page.rows.length - 1];
        return ok({
          entries: resolved.map((r) => ({ id: r.id, data: r.data })),
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

      case "get_entry": {
        const a = z.object({ collection: z.string(), id: z.string() }).parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const row = await getEntry(c, a.id);
        if (!row) return err(`no entry ${a.id} in "${a.collection}"`, "E_NOT_FOUND");
        const [resolved] = await resolveRefsForRead(projectId, c, [row]);
        return ok({ id: resolved.id, data: resolved.data });
      }

      case "count_entries": {
        const a = queryArgs
          .omit({ limit: true, offset: true, orderBy: true, select: true, cursor: true })
          .parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        return ok({ count: await countEntries(c, a.where ?? []) });
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
        const result = await aggregateEntries(c, {
          aggregates: a.aggregates,
          groupBy: a.groupBy,
          where: a.where,
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

      case "get_audit_log": {
        const a = z
          .object({
            collection: z.string().optional(),
            entryId: z.string().optional(),
            action: z.enum(["create", "update", "delete"]).optional(),
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

      default:
        return err(`unknown tool "${name}"`, "E_UNKNOWN_TOOL");
    }
  } catch (e) {
    if (e instanceof z.ZodError) return err(formatZodError(e), "E_VALIDATION");
    if (e instanceof ValidationError) return err(e.message, e.code);
    return err(e instanceof Error ? e.message : String(e), "E_INTERNAL");
  }
}
