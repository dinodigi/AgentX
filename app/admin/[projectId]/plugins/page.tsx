import { notFound } from "next/navigation";
import { getProjectRole } from "@/lib/access";
import { effectiveCatalog, enabledPlugins, providesOf } from "@/lib/plugins";
import { PluginStore } from "./PluginStore";

/**
 * The Plugins tab — the store. Every plugin the operator has activated for
 * the fleet (plus this project's private defs), as browsable cards with
 * enable/disable. Enabling records the capability; the project's AI applies
 * and operates it via MCP (list_plugins → get_plugin).
 */
export default async function PluginsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const role = await getProjectRole(projectId);
  if (!role) notFound();

  const [catalog, enabled] = await Promise.all([effectiveCatalog(projectId), enabledPlugins(projectId)]);
  return (
    <>
      <p className="eyebrow mb-1">Project</p>
      <h1 className="display mb-1 text-xl font-semibold">Plugins</h1>
      <p className="mb-6 max-w-lg text-sm text-ink-mute">
        Installable capabilities — a plugin carries a content model, tools, and the operating
        guidance your AI follows. Enable one here, then tell your agent to apply it.
      </p>
      <PluginStore
        projectId={projectId}
        canManage={role === "operator"}
        plugins={catalog.map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          description: p.description,
          enabled: enabled.has(p.id),
          priceCents: p.priceCents ?? null,
          hasStructure: Boolean(p.structure),
          tools: p.tools ?? [],
          provides: providesOf(p),
          requires: p.requires ?? [],
        }))}
      />
    </>
  );
}
