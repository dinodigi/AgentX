import "server-only";
import { and, eq, isNull, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { unstable_cache, revalidateTag } from "next/cache";
import { z } from "zod";
import { controlDb } from "@/db";
import { pluginDefs, projectPlugins } from "@/db/schema";
import { validateFieldDefs, ValidationError } from "./validation";
import type { FieldDef } from "./field-types";

/**
 * The plugin system (Post-Deployment v1.0 Track 2) — ONE installable unit.
 * There is no separate "template": a structure-only plugin IS what people
 * loosely call a template, installed through the same mechanism.
 *
 * A plugin declares up to three ingredients:
 *  - structure: a DECLARATIVE content-model intent + a known-good baseline the
 *    AI RECONCILES against the actual project (adapt naming, merge overlapping
 *    collections, add project-specific fields) — never a blind stamp. That's
 *    what makes multi-plugin projects compose.
 *  - tools: extra MCP verbs unlocked by enabling (gated via pluginEnabled).
 *  - guidance: domain operating context the AI reads before acting.
 * Plus acceptance criteria — the precise contract that makes a marketplace
 * install reliable instead of "the AI's mood".
 *
 * v1: the catalog is in-code (versioned with the app, like TOOL_DEFS);
 * enablement is per-project (project_plugins). Discovery is AI-first: the MCP
 * tools list_plugins / get_plugin / enable_plugin — "the AI pings the project,
 * sees the available plugins, and draws on them on demand."
 */

export interface PluginDef {
  /** snake_case id — the enablement key and `_type`-style discriminator. */
  id: string;
  version: string;
  name: string;
  /** One-liner for list_plugins. */
  description: string;
  structure?: {
    /** What the target model achieves (the intent the AI realizes). */
    intent: string;
    /** Known-good starting spec — collections the AI adapts, not stamps.
     * Carries anything define_collection accepts (workflow, publicFilter,
     * access, events) — validated when APPLIED, exactly like a direct call. */
    baseline: {
      name: string;
      displayName?: string;
      publicWrite?: boolean;
      fields: FieldDef[];
      workflow?: unknown;
      publicFilter?: unknown;
      access?: unknown;
      events?: unknown;
    }[];
    /** How to adapt/merge with what already exists (composition rules). */
    reconcile: string;
  };
  /** MCP tool names this plugin unlocks (checked via pluginEnabled). */
  tools?: string[];
  /** Domain operating context for the AI. */
  guidance?: string;
  /** Verify-after-apply criteria — each must hold before the install is done. */
  acceptance?: string[];
}

export const PLUGIN_CATALOG: PluginDef[] = [
  {
    id: "seo",
    version: "1.1.0",
    name: "SEO agent",
    description:
      "Site-wide audit → scorecard → fix → re-score loop: audit_site (multi-page/sitemap) + fetch_page + score_page, an `seo` group on page-shaped collections, and the operating guidance. Read-only against the site; fixes flow through entries.",
    structure: {
      intent:
        "Every page-shaped collection carries an `seo` group the site's <head> renders from, so " +
        "search/share metadata is CONTENT (auditable, fixable, versioned) instead of hardcoded.",
      baseline: [
        {
          name: "pages",
          displayName: "Pages",
          fields: [
            { name: "title", label: "Title", type: "text", required: true, publicRead: true },
            {
              name: "seo",
              label: "SEO",
              type: "group",
              publicRead: true,
              fields: [
                { name: "title", label: "Meta title", type: "text", max: 70 },
                { name: "description", label: "Meta description", type: "text", max: 200 },
                { name: "canonical", label: "Canonical URL", type: "text" },
                { name: "og_title", label: "OG title", type: "text", max: 100 },
                { name: "og_description", label: "OG description", type: "text", max: 300 },
                { name: "og_image", label: "OG image", type: "asset" },
                { name: "noindex", label: "Hide from search", type: "boolean" },
              ],
            },
          ],
        },
      ],
      reconcile:
        "The `pages` collection here is a REFERENCE — do not create it if the project already has " +
        "page-shaped collections. Instead ADD the `seo` group (define_collection update) to each " +
        "existing collection that renders as a page (pages, posts, products…). Keep the group " +
        "publicRead so the site's head template can read it.",
    },
    tools: ["fetch_page", "score_page", "audit_site"],
    guidance:
      "Operate the loop SITE-WIDE (v2): audit_site with the sitemap (or key urls, max 10) → for " +
      "each page, write its fixes into the matching entry's `seo` group (update_entry — the user " +
      "confirms the fix plan in chat before you write) → the site renders them (its layout reads " +
      "the group via the delivery API, e.g. Next.js generateMetadata) → audit_site again to PROVE " +
      "the scores moved. Findings' `fix` fields name the exact seo.* field to write. Pages are read " +
      "LIVE, so a fix only shows after the site redeploys/revalidates. score_page remains for " +
      "single-URL spot checks.",
    acceptance: [
      "each page-shaped collection carries a publicRead `seo` group with at least title + description",
      "score_page returns a scorecard for the site's key URLs",
      "after writing fixes and the site re-rendering, re-scored pages improve",
    ],
  },
  {
    id: "contact_forms",
    version: "1.0.0",
    name: "Contact forms",
    description:
      "Production contact/lead-capture model: a publicWrite inbox with moderation, webhook/email notification — structure + guidance, no extra tools.",
    structure: {
      intent:
        "The project can receive contact-form submissions from its live site: an inbox collection " +
        "that anonymous visitors can POST to, whose rows appear in the admin, with a moderation " +
        "status the submitter can never set.",
      baseline: [
        {
          name: "inbox",
          displayName: "Inbox",
          publicWrite: true,
          fields: [
            { name: "name", label: "Name", type: "text", required: true },
            { name: "email", label: "Email", type: "text", required: true, max: 320 },
            { name: "message", label: "Message", type: "richtext", required: true, max: 10000 },
            {
              name: "status",
              label: "Status",
              type: "enum",
              options: ["new", "replied", "archived"],
              writableBy: "none",
            },
          ],
        },
      ],
      reconcile:
        "If the project already has a form/inbox-shaped collection (publicWrite with an email " +
        "field), EXTEND it — add the missing fields and the status enum — instead of creating a " +
        "second inbox. Match the project's existing naming style. Add the project-specific fields " +
        "its forms actually send (phone, company, budget…). Never make submitter PII publicRead.",
    },
    guidance:
      "A form = a publicWrite collection: the site POSTs to /v1/{collection} with the delivery " +
      "token. Set webhookUrl on the collection (define_collection) or an email action to get " +
      "notified per submission. Submitter fields stay writable; moderation fields are " +
      "writableBy:'none' so an anonymous POST can never set them.",
    acceptance: [
      "a publicWrite collection exists with required name + email + message fields",
      "its moderation/status field is writableBy:'none' (an anonymous POST setting it is rejected 403)",
      "an anonymous POST with only the submitter fields returns 201 and the row is visible via query_entries",
    ],
  },
];

/**
 * Track 6 (DB-backed catalog): the EFFECTIVE catalog a project sees =
 * in-code built-ins + platform-global DB defs + this project's own defs.
 * Client plugins live in plugin_defs, never the binary. Cached 60s + tagged
 * (the standing rule: revalidateTag is per-instance; TTL converges the fleet).
 */
export async function effectiveCatalog(projectId: string): Promise<PluginDef[]> {
  const cached = unstable_cache(
    async () => {
      const rows = await controlDb
        .select({ id: pluginDefs.id, projectId: pluginDefs.projectId, definition: pluginDefs.definition })
        .from(pluginDefs)
        .where(or(isNull(pluginDefs.projectId), eq(pluginDefs.projectId, projectId)));
      return rows;
    },
    ["plugin-defs", projectId],
    { tags: ["plugin-defs", `project:${projectId}`], revalidate: 60 },
  );
  const rows = await cached();
  const fromDb = rows.map((r) => r.definition as unknown as PluginDef);
  // A DB def with a built-in's id overrides it (project-scoped wins last).
  const byId = new Map<string, PluginDef>();
  for (const p of [...PLUGIN_CATALOG, ...fromDb]) byId.set(p.id, p);
  return [...byId.values()];
}

export async function getPluginDef(projectId: string, id: string): Promise<PluginDef | null> {
  return (await effectiveCatalog(projectId)).find((p) => p.id === id) ?? null;
}

/** The project's enabled plugin ids. */
export async function enabledPlugins(projectId: string): Promise<Set<string>> {
  const rows = await controlDb
    .select({ pluginId: projectPlugins.pluginId })
    .from(projectPlugins)
    .where(eq(projectPlugins.projectId, projectId));
  return new Set(rows.map((r) => r.pluginId));
}

export async function pluginEnabled(projectId: string, pluginId: string): Promise<boolean> {
  const rows = await controlDb
    .select({ pluginId: projectPlugins.pluginId })
    .from(projectPlugins)
    .where(and(eq(projectPlugins.projectId, projectId), eq(projectPlugins.pluginId, pluginId)))
    .limit(1);
  return rows.length > 0;
}

/** Idempotent enable — enabling twice is a no-op, never an error. */
export async function enablePlugin(projectId: string, pluginId: string): Promise<void> {
  await controlDb.insert(projectPlugins).values({ projectId, pluginId }).onConflictDoNothing();
}

export async function disablePlugin(projectId: string, pluginId: string): Promise<void> {
  await controlDb
    .delete(projectPlugins)
    .where(and(eq(projectPlugins.projectId, projectId), eq(projectPlugins.pluginId, pluginId)));
}

/* ── DB-backed authoring (Track 6) ─────────────────────────────────────── */

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const baselineCollectionSchema = z
  .object({
    name: z.string().regex(NAME_RE),
    displayName: z.string().optional(),
    publicWrite: z.boolean().optional(),
    fields: z.array(z.unknown()).min(1),
    // Validated when APPLIED via define_collection — carried opaquely here.
    workflow: z.unknown().optional(),
    publicFilter: z.unknown().optional(),
    access: z.unknown().optional(),
    events: z.unknown().optional(),
  })
  .strict();
const pluginDefSchema = z
  .object({
    id: z.string().regex(NAME_RE, "plugin id must be snake_case"),
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    structure: z
      .object({ intent: z.string().min(1), baseline: z.array(baselineCollectionSchema), reconcile: z.string().min(1) })
      .strict()
      .optional(),
    tools: z.array(z.string()).optional(),
    guidance: z.string().optional(),
    acceptance: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Author/update a plugin definition. projectId set → visible ONLY to that
 * project (the MCP path — an agent can never publish into other tenants'
 * catalogs); projectId null → platform-global (operator/seed-script only).
 * Baseline field defs are deep-validated now; workflow/filters validate at
 * apply time through define_collection like any direct call.
 */
export async function upsertPluginDef(def: unknown, projectId: string | null): Promise<PluginDef> {
  let parsed: z.infer<typeof pluginDefSchema>;
  try {
    parsed = pluginDefSchema.parse(def);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new ValidationError(
        "invalid plugin definition: " + e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      );
    }
    throw e;
  }
  for (const c of parsed.structure?.baseline ?? []) {
    try {
      validateFieldDefs(c.fields);
    } catch (e) {
      throw new ValidationError(
        `baseline collection "${c.name}": ${e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : "invalid fields"}`,
      );
    }
  }
  // Built-in ids are reserved — a DB def must not shadow seo/contact_forms.
  if (PLUGIN_CATALOG.some((p) => p.id === parsed.id)) {
    throw new ValidationError(`"${parsed.id}" is a built-in plugin id — pick another`);
  }
  const scope = projectId ?? null;
  await controlDb.execute(sql`
    INSERT INTO plugin_defs (id, project_id, definition, updated_at)
    VALUES (${parsed.id}, ${scope}, ${JSON.stringify(parsed)}::jsonb, now())
    ON CONFLICT (id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET definition = EXCLUDED.definition, updated_at = now()`);
  revalidateTag("plugin-defs");
  if (projectId) revalidateTag(`project:${projectId}`);
  return parsed as PluginDef;
}

export async function deletePluginDef(id: string, projectId: string | null): Promise<boolean> {
  const result = await controlDb.execute(sql`
    DELETE FROM plugin_defs WHERE id = ${id}
      AND COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE(${projectId}, '00000000-0000-0000-0000-000000000000'::uuid)`);
  revalidateTag("plugin-defs");
  const rows = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  return rows > 0;
}
