import "server-only";
import { and, eq, isNull, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { unstable_cache, revalidateTag } from "next/cache";
import { z } from "zod";
import { controlDb } from "@/db";
import { pluginDefs, projectPlugins } from "@/db/schema";
import { validateFieldDefs, ValidationError } from "./validation";
import { getSetting, setSetting } from "./platform-settings";
import { SEO_PLUGIN } from "@/plugins/seo";
import { CONTACT_FORMS_PLUGIN } from "@/plugins/contact-forms";
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
  /** Attached from operator overrides at read time (never stored on the def):
   * display price in cents (billing enforcement is a later phase). */
  priceCents?: number | null;
}

/** Operator per-plugin overrides (platform_settings key "pluginOverrides"). */
export interface PluginOverride {
  /** false hides the plugin fleet-wide (store, list_plugins, enable). */
  active?: boolean;
  priceCents?: number | null;
}

export async function pluginOverrides(): Promise<Record<string, PluginOverride>> {
  const raw = (await getSetting("pluginOverrides")) ?? {};
  return raw as Record<string, PluginOverride>;
}

/**
 * Operator management view: built-ins + ALL global defs (never tenants'
 * private defs), UNFILTERED (inactive included), override attached.
 */
export async function operatorCatalog(): Promise<(PluginDef & { override: PluginOverride })[]> {
  const rows = await controlDb
    .select({ definition: pluginDefs.definition })
    .from(pluginDefs)
    .where(isNull(pluginDefs.projectId));
  const byId = new Map<string, PluginDef>();
  for (const p of [...PLUGIN_CATALOG, ...rows.map((r) => r.definition as unknown as PluginDef)]) byId.set(p.id, p);
  const overrides = await pluginOverrides();
  return [...byId.values()].map((p) => ({ ...p, override: overrides[p.id] ?? {} }));
}

export async function savePluginOverride(id: string, override: PluginOverride): Promise<void> {
  const all = await pluginOverrides();
  const next = { ...all, [id]: { ...all[id], ...override } };
  await setSetting("pluginOverrides", next as Record<string, unknown>);
}

export const PLUGIN_CATALOG: PluginDef[] = [SEO_PLUGIN, CONTACT_FORMS_PLUGIN];

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
  // Operator overrides: active:false hides fleet-wide; price attaches for display.
  const overrides = await pluginOverrides();
  return [...byId.values()]
    .filter((p) => overrides[p.id]?.active !== false)
    .map((p) => ({ ...p, priceCents: overrides[p.id]?.priceCents ?? null }));
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
