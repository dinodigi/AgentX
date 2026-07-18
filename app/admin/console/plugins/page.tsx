import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/access";
import { operatorCatalog } from "@/lib/plugins";
import { WorkspaceSidebar } from "@/components/admin/WorkspaceSidebar";
import { PluginManager } from "./PluginManager";

/**
 * Operator plugin management: fleet-wide activate/deactivate + display price
 * for every built-in and global plugin (tenants' private defs are theirs).
 * Deactivating hides a plugin everywhere: store tab, list_plugins, enable.
 */
export default async function PluginManagementPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  if (!viewer.isPlatformOperator) redirect("/admin");

  const catalog = await operatorCatalog();
  return (
    <>
      <WorkspaceSidebar canCreateProjects isPlatformOperator />
      <div className="page-enter min-w-0 flex-1 px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Plugin management</h1>
            <p className="text-sm text-ink-mute">
              Activate/deactivate fleet-wide and set display prices. Billing enforcement is a later
              phase — price shows in the store; enabling stays free.
            </p>
          </div>
          <Link href="/admin/console" className="btn btn-ghost text-sm">
            ← Console
          </Link>
        </div>
        <PluginManager
          plugins={catalog.map((p) => ({
            id: p.id,
            name: p.name,
            version: p.version,
            description: p.description,
            active: p.override.active !== false,
            priceCents: p.override.priceCents ?? null,
          }))}
        />
      </div>
    </>
  );
}
