import "server-only";
import { sql } from "drizzle-orm";
import { controlDb } from "@/db";
import { platformNotices } from "@/db/schema";
import { defer } from "./defer";

/**
 * B1 (friction sprint): live sessions must learn the tool surface changed.
 *
 * Field proof (Codex/Replit, 2026-07-23): a session connected minutes before
 * a deploy spent the whole night on the OLD tool list — MCP clients cache
 * tools/list per connection, and Render's rolling deploy kept the old
 * instance serving the established session. The agent then filed "delivery
 * token creation is not reachable over MCP" for a capability that had been
 * live for hours. It DID call get_project_info mid-session — the briefing was
 * the channel that could have told it, and said nothing.
 *
 * Mechanism: self-detection, no deploy hook to remember. Once per instance
 * lifetime, compare the live TOOL_DEFS name-set against the snapshot stored
 * in platform_settings ('toolSurface'). On a difference, ONE instance wins an
 * atomic compare-and-swap on the snapshot row and authors a platform notice
 * naming exactly what appeared/disappeared; every project's next
 * get_project_info then carries it once (the existing briefingSeenAt flow).
 * Losing instances see the snapshot already swapped and stay silent.
 */

let checkedThisInstance = false;

export function ensureToolSurfaceNotice(toolNames: string[]): void {
  if (checkedThisInstance) return;
  checkedThisInstance = true;
  // Deferred + swallowed: surface bookkeeping must never delay or fail a
  // tool call (same contract as recordPlatformEvent).
  defer(async () => {
    try {
      const names = [...toolNames].sort();
      const sig = names.join(",");
      // Atomic winner-selection: the UPDATE only applies when the stored
      // signature differs, and RETURNING tells us whether WE applied it.
      // First boot (no row) takes the INSERT arm and stays silent — a brand
      // new deployment has no sessions to notify.
      const result = await controlDb.execute(sql`
        INSERT INTO platform_settings (key, value)
        VALUES ('toolSurface', ${JSON.stringify({ sig, names })}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        WHERE platform_settings.value->>'sig' IS DISTINCT FROM ${sig}
        RETURNING (xmax = 0) AS inserted`);
      const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
        inserted: boolean;
      }[];
      if (!rows[0]) return; // lost the race or surface unchanged
      if (rows[0].inserted) {
        // First boot ever: seed the diff baseline silently — there is no
        // previous surface to compare against, but the NEXT change needs one.
        await controlDb.execute(sql`
          INSERT INTO platform_settings (key, value)
          VALUES ('toolSurfacePrev', ${JSON.stringify({ names })}::jsonb)
          ON CONFLICT (key) DO NOTHING`);
        return;
      }

      const prevRaw = await controlDb.execute(sql`
        SELECT value FROM platform_settings WHERE key = 'toolSurfacePrev'`);
      // Diff against the previous snapshot we stash alongside; if absent
      // (first rollout of this feature), fall back to announcing nothing.
      const prevRows = (Array.isArray(prevRaw) ? prevRaw : ((prevRaw as { rows?: unknown[] }).rows ?? [])) as {
        value?: { names?: string[] };
      }[];
      const prev = prevRows[0]?.value?.names ?? null;
      await controlDb.execute(sql`
        INSERT INTO platform_settings (key, value)
        VALUES ('toolSurfacePrev', ${JSON.stringify({ names })}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
      if (!prev) return;

      const added = names.filter((n) => !prev.includes(n));
      const removed = prev.filter((n) => !names.includes(n));
      if (!added.length && !removed.length) return;

      const parts: string[] = [];
      if (added.length) parts.push(`new tools: ${added.join(", ")}`);
      if (removed.length) parts.push(`removed: ${removed.join(", ")}`);
      await controlDb.insert(platformNotices).values({
        message:
          `platform deploy changed the MCP tool surface — ${parts.join("; ")}. ` +
          `If your session started before this notice, your client's cached tool list is stale: re-run tools/list.`,
        // Removals can break an in-flight plan; additions are just news.
        severity: removed.length ? "attention" : "info",
      });
    } catch (e) {
      console.error("tool-surface notice skipped:", e instanceof Error ? e.message : e);
    }
  });
}
