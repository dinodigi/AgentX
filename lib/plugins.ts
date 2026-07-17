import "server-only";
import { and, eq } from "drizzle-orm";
import { controlDb } from "@/db";
import { projectPlugins } from "@/db/schema";
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
    /** Known-good starting spec — collections the AI adapts, not stamps. */
    baseline: {
      name: string;
      displayName?: string;
      publicWrite?: boolean;
      fields: FieldDef[];
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

export function getPluginDef(id: string): PluginDef | null {
  return PLUGIN_CATALOG.find((p) => p.id === id) ?? null;
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
