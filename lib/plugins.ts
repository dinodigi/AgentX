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
  /** Composition core (Plugin Bases Plan, Track A): the capability(ies) this
   * plugin OWNS. Bases declare exactly one; interim monoliths (countryside,
   * pre-blueprint) may declare several honestly. Enable rule: one ACTIVE
   * provider per capability — enforced on NEW enables only (grandfather rule:
   * pre-existing enablements are never touched). */
  provides?: string | string[];
  /** Capabilities this plugin depends on. Enabling auto-enables the provider
   * when the catalog has exactly ONE; ambiguity or absence is a clear error. */
  requires?: string[];
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

/** Idempotent enable — enabling twice re-stamps the acknowledged version
 * (Track C): after adopting an update via reconcile, the agent calls
 * enable_plugin again and the drift offer clears. */
export async function enablePlugin(projectId: string, pluginId: string, version?: string | null): Promise<void> {
  await controlDb
    .insert(projectPlugins)
    .values({ projectId, pluginId, version: version ?? null })
    .onConflictDoUpdate({
      target: [projectPlugins.projectId, projectPlugins.pluginId],
      set: { version: version ?? null },
    });
}

/** Enabled plugin ids with the version acknowledged at enable time (null =
 * enabled before version tracking — shows as an adopt-current offer). */
export async function enabledPluginVersions(projectId: string): Promise<Map<string, string | null>> {
  const rows = await controlDb
    .select({ pluginId: projectPlugins.pluginId, version: projectPlugins.version })
    .from(projectPlugins)
    .where(eq(projectPlugins.projectId, projectId));
  return new Map(rows.map((r) => [r.pluginId, r.version]));
}

export async function disablePlugin(projectId: string, pluginId: string): Promise<void> {
  await controlDb
    .delete(projectPlugins)
    .where(and(eq(projectPlugins.projectId, projectId), eq(projectPlugins.pluginId, pluginId)));
}

/* ── Composition core (Plugin Bases Plan, Track A) ─────────────────────── */

/** Normalized capability list a def provides. */
export function providesOf(def: PluginDef): string[] {
  return def.provides === undefined ? [] : Array.isArray(def.provides) ? def.provides : [def.provides];
}

export interface EnablePlan {
  /** Plugins enabled by this call (target first, then auto-enabled requires). */
  enabled: string[];
  /** Providers disabled by an explicit swap. */
  disabled: string[];
  /** Human/agent-readable notes about what composition did and why. */
  notes: string[];
}

const REQUIRES_DEPTH = 5;

/**
 * Composition-aware enable. Enforces ONE ACTIVE PROVIDER PER CAPABILITY on
 * new enables (grandfather rule: pre-existing enablements are never touched
 * by this — enforcement lives only here, in the enable path), resolves
 * `requires` (auto-enables a capability's provider when the catalog has
 * exactly one), and performs explicit swaps when asked. Legacy defs without
 * `provides` compose freely, exactly as before.
 */
export async function enablePluginChecked(
  projectId: string,
  pluginId: string,
  opts: { swap?: boolean } = {},
): Promise<EnablePlan> {
  const catalog = await effectiveCatalog(projectId);
  const target = catalog.find((p) => p.id === pluginId);
  if (!target) throw new ValidationError(`unknown plugin "${pluginId}" — list_plugins shows what's available`, "E_NOT_FOUND");

  const active = await enabledPlugins(projectId);
  if (active.has(pluginId)) {
    // Idempotent re-enable = version acknowledgment (Track C): re-stamp to the
    // current catalog version so the briefing's update offer clears.
    await enablePlugin(projectId, pluginId, target.version);
    return {
      enabled: [],
      disabled: [],
      notes: [`"${pluginId}" was already enabled — acknowledged version ${target.version}`],
    };
  }

  const byId = new Map(catalog.map((p) => [p.id, p]));
  const capsProvidedBy = (ids: Iterable<string>) => {
    const m = new Map<string, string[]>(); // capability -> provider ids
    for (const id of ids) {
      const def = byId.get(id);
      if (!def) continue; // enabled row whose def vanished — tolerate
      for (const c of providesOf(def)) m.set(c, [...(m.get(c) ?? []), id]);
    }
    return m;
  };

  // Resolve the full to-enable set (target + transitive requires).
  const toEnable: string[] = [];
  const notes: string[] = [];
  const visit = (id: string, depth: number) => {
    if (toEnable.includes(id) || active.has(id)) return;
    if (depth > REQUIRES_DEPTH) throw new ValidationError(`requires chain deeper than ${REQUIRES_DEPTH} — simplify the defs`);
    const def = byId.get(id);
    if (!def) throw new ValidationError(`required plugin "${id}" is not in this project's catalog`);
    toEnable.push(id);
    for (const cap of def.requires ?? []) {
      const activeCaps = capsProvidedBy(active);
      const pendingCaps = capsProvidedBy(toEnable);
      if (activeCaps.has(cap) || pendingCaps.has(cap)) continue; // satisfied
      const providers = catalog.filter((p) => providesOf(p).includes(cap));
      if (providers.length === 0) {
        throw new ValidationError(
          `"${def.id}" requires capability "${cap}" but no plugin in the catalog provides it`,
        );
      }
      if (providers.length > 1) {
        throw new ValidationError(
          `"${def.id}" requires "${cap}", provided by several plugins (${providers.map((p) => p.id).join(", ")}) — enable ONE of them first, then retry`,
        );
      }
      notes.push(`auto-enabled "${providers[0].id}" — "${def.id}" requires "${cap}"`);
      visit(providers[0].id, depth + 1);
    }
  };
  visit(pluginId, 0);

  // One-provider rule: capabilities the new set brings vs currently active.
  const activeCaps = capsProvidedBy(active);
  const conflicts = new Map<string, string[]>(); // capability -> active provider ids
  for (const id of toEnable) {
    for (const cap of providesOf(byId.get(id)!)) {
      const holders = activeCaps.get(cap);
      if (holders?.length) conflicts.set(cap, holders);
    }
  }
  // A capability provided twice WITHIN the new set is a def bug — refuse.
  const pendingCaps = capsProvidedBy(toEnable);
  for (const [cap, ids] of pendingCaps) {
    if (ids.length > 1) throw new ValidationError(`capability "${cap}" is provided by two plugins in this enable (${ids.join(", ")}) — resolve the defs`);
  }

  const toDisable = [...new Set([...conflicts.values()].flat())];
  if (conflicts.size > 0 && !opts.swap) {
    const lines = [...conflicts.entries()]
      .map(([cap, ids]) => `"${cap}" is already provided by enabled plugin ${ids.map((i) => `"${i}"`).join(" + ")}`)
      .join("; ");
    throw new ValidationError(
      `${lines} — one active provider per capability. Keep the current provider, or re-run with swap:true to disable ${toDisable.map((i) => `"${i}"`).join(", ")} and enable "${pluginId}" (content/collections stay either way).`,
      "E_CONFLICT",
    );
  }
  for (const id of toDisable) {
    await disablePlugin(projectId, id);
    notes.push(`swap: disabled "${id}" (its collections/content remain)`);
  }
  for (const id of toEnable) await enablePlugin(projectId, id, byId.get(id)?.version ?? null);
  return { enabled: toEnable, disabled: toDisable, notes };
}

/**
 * Composition-aware disable: never blocks (operator freedom), but names the
 * still-enabled plugins whose `requires` lose their provider by this.
 */
export async function disablePluginChecked(projectId: string, pluginId: string): Promise<{ warning?: string }> {
  const catalog = await effectiveCatalog(projectId);
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const active = await enabledPlugins(projectId);
  await disablePlugin(projectId, pluginId);
  const gone = byId.get(pluginId);
  if (!gone) return {};
  const lostCaps = providesOf(gone).filter(
    (cap) =>
      ![...active].some((id) => id !== pluginId && byId.get(id) && providesOf(byId.get(id)!).includes(cap)),
  );
  if (lostCaps.length === 0) return {};
  const orphans = [...active].filter(
    (id) => id !== pluginId && (byId.get(id)?.requires ?? []).some((cap) => lostCaps.includes(cap)),
  );
  if (orphans.length === 0) return {};
  return {
    warning: `still-enabled ${orphans.map((i) => `"${i}"`).join(", ")} require ${lostCaps.map((c) => `"${c}"`).join(", ")}, which no enabled plugin now provides — re-enable a provider or expect degraded behavior`,
  };
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
const capabilityToken = z
  .string()
  .regex(NAME_RE, "capabilities are snake_case tokens, e.g. lead_capture")
  .max(40);
const pluginDefSchema = z
  .object({
    id: z.string().regex(NAME_RE, "plugin id must be snake_case"),
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    provides: z.union([capabilityToken, z.array(capabilityToken).min(1).max(8)]).optional(),
    requires: z.array(capabilityToken).max(8).optional(),
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
