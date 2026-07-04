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
  queryEntries,
  resolveRelations,
  ValidationError,
} from "@/lib/entries";
import { uploadAsset } from "@/lib/r2";
import { exportProject, importProject } from "@/lib/manifest";
import { formatZodError } from "@/lib/validation";

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

export const TOOL_DEFS: ToolDef[] = [
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
      "the admin; no per-project UI code. Set publicWrite:true + webhookUrl for a form. " +
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
      "List entries in a collection (relations resolved to {id,label}). Supports limit/offset, " +
      "where filters [{field, op: eq|contains|gt|lt, value}] and orderBy {field, dir: asc|desc}. " +
      "Ops are type-checked: contains=text/richtext, gt/lt=number/date. No full-text search service.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
        where: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              op: { type: "string", enum: ["eq", "contains", "gt", "lt"] },
              value: {},
            },
            required: ["field", "op", "value"],
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

const defineArgs = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  fields: z.array(z.any()),
  publicWrite: z.boolean().optional(),
  webhookUrl: z.string().url().optional(),
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
  where: z
    .array(
      z.object({
        field: z.string(),
        op: z.enum(["eq", "contains", "gt", "lt"]),
        value: z.union([z.string(), z.number(), z.boolean()]),
      }),
    )
    .optional(),
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
function err(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

async function mustCollection(projectId: string, name: string) {
  const c = await getCollection(projectId, name);
  if (!c) throw new ValidationError(`collection "${name}" not found`);
  return c;
}

/** Dispatch a tool call for a resolved project. Never throws — returns ToolResult. */
export async function callTool(
  projectId: string,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  try {
    switch (name) {
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
          confirm: a.confirm,
        });
        if (!result.applied) {
          return ok({
            requiresConfirmation: true,
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
          fields: c.fields,
        });
      }

      case "delete_collection": {
        const a = z
          .object({ name: z.string(), confirm: z.boolean().optional() })
          .parse(rawArgs);
        const plan = await planDeleteCollection(projectId, a.name);
        if (!plan) return err(`collection "${a.name}" not found`);
        if (plan.inboundRelations.length > 0) {
          return err(
            `blocked: relation fields still target "${a.name}": ` +
              plan.inboundRelations.map((r) => `${r.collection}.${r.field}`).join(", ") +
              ". Redefine those collections without these fields first.",
          );
        }
        if (!a.confirm) {
          return ok({
            requiresConfirmation: true,
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
        });
        return ok({ id: e.id, data: e.data });
      }

      case "update_entry": {
        const a = updateArgs.parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const e = await updateEntry(projectId, c, a.id, a.data);
        return ok({ id: e.id, data: e.data });
      }

      case "delete_entry": {
        const a = updateArgs.omit({ data: true }).parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        await deleteEntry(c, a.id);
        return ok({ deleted: a.id });
      }

      case "query_entries": {
        const a = queryArgs.parse(rawArgs);
        const c = await mustCollection(projectId, a.collection);
        const rows = await queryEntries(c, {
          limit: a.limit,
          offset: a.offset,
          where: a.where,
          orderBy: a.orderBy,
        });
        const resolved = await resolveRelations(projectId, c, rows);
        return ok(resolved.map((r) => ({ id: r.id, data: r.data })));
      }

      case "export_project":
        return ok(await exportProject(projectId));

      case "import_project": {
        const a = z
          .object({ manifest: z.record(z.unknown()), confirm: z.boolean().optional() })
          .parse(rawArgs);
        const result = await importProject(projectId, a.manifest, a.confirm ?? false);
        return ok(result);
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
        return err(`unknown tool "${name}"`);
    }
  } catch (e) {
    if (e instanceof z.ZodError) return err(formatZodError(e));
    if (e instanceof ValidationError) return err(e.message);
    return err(e instanceof Error ? e.message : String(e));
  }
}
