import "server-only";
import { cookies } from "next/headers";

/**
 * Workspace theme is a per-operator preference (cookie), read at SSR so the
 * shell paints the right register with no flash. The sidebar toggle writes it.
 */
export const THEME_COOKIE = "ax_theme";

export async function getWorkspaceTheme(): Promise<"dark" | "light"> {
  const c = await cookies();
  return c.get(THEME_COOKIE)?.value === "light" ? "light" : "dark";
}

/** Whether the project sidebar starts collapsed (operator preference, per SSR). */
export const SIDEBAR_COOKIE = "ax_sidebar";

export async function getSidebarCollapsed(): Promise<boolean> {
  const c = await cookies();
  return c.get(SIDEBAR_COOKIE)?.value === "1";
}

/** The dashboard's active-workspace context (B1c); the switcher writes it. */
export const WORKSPACE_COOKIE = "ax_workspace";

export async function getActiveWorkspaceCookie(): Promise<string | undefined> {
  const c = await cookies();
  return c.get(WORKSPACE_COOKIE)?.value;
}
