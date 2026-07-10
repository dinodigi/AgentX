import type { ReactNode } from "react";
import { getWorkspaceTheme } from "@/lib/theme";

/**
 * Admin theme root. Reads the operator's workspace theme cookie at SSR and
 * stamps [data-theme] on a single wrapper — the sidebar toggle flips this same
 * element, so the whole workspace switches register with no reload and no flash.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const theme = await getWorkspaceTheme();
  return (
    <div data-theme-root data-theme={theme} className="min-h-screen bg-paper text-ink">
      {children}
    </div>
  );
}
