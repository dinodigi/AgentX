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
