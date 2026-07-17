import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/access";
import { effectiveCaps, getSetting } from "@/lib/platform-settings";
import { WorkspaceSidebar } from "@/components/admin/WorkspaceSidebar";
import { SettingsForm } from "./SettingsForm";

/**
 * Platform Settings — operator-only console page: plan caps + metered billing
 * rates live in platform_settings and take effect immediately (the enforcement
 * gates and the drain's usage reporter read the same effectiveCaps /
 * effectiveMeteredRates the form edits).
 */
export default async function PlatformSettingsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  if (!viewer.isPlatformOperator) redirect("/admin");

  const caps = await effectiveCaps();
  const ratesSetting = await getSetting("meteredRates");
  const rates = ratesSetting
    ? {
        computeCentsPerCuHour: Number(ratesSetting.computeCentsPerCuHour),
        storageCentsPerGbMonth: Number(ratesSetting.storageCentsPerGbMonth),
      }
    : null;

  return (
    <>
      <WorkspaceSidebar canCreateProjects isPlatformOperator />
      <div className="page-enter min-w-0 flex-1 px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Platform settings</h1>
            <p className="text-sm text-ink-mute">Caps and billing rates — fleet-wide, effective immediately.</p>
          </div>
          <Link href="/admin/console" className="btn btn-ghost text-sm">
            ← Console
          </Link>
        </div>
        <SettingsForm
          initial={{
            sandbox: caps.sandbox,
            paid: caps.paid,
            rates,
            ratesFromEnv: rates === null && Boolean(process.env.METERED_RATES),
          }}
        />
      </div>
    </>
  );
}
