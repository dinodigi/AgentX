/**
 * Regenerate the live sections of docs/pm/BOARD.md from real state.
 *
 * Two sources, both of which have rotted before:
 *  - the FEEDBACK WALL (production DB) — on 2026-07-25 it read 20 open when 18
 *    were already fixed.
 *  - the BACKLOG (docs/BACKLOG.md) — on 2026-07-26 three HIGH items (MT-1,
 *    OPS-4, DX-6) still read "not started" days after shipping.
 *
 * Both failed the same way: nobody fed them. So neither is hand-copied here —
 * they are parsed, and a stale row shows up next to live work instead of hiding
 * in a 250-line file. Only content between the marker blocks is replaced.
 *
 *   npm run pm
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync, writeFileSync } from "node:fs";

const BOARD = "docs/pm/BOARD.md";
const sql = neon(process.env.DATABASE_URL);

function replaceBlock(doc, name, body) {
  const re = new RegExp(`(<!-- BEGIN:${name} -->)[\\s\\S]*?(<!-- END:${name} -->)`);
  if (!re.test(doc)) throw new Error(`marker block "${name}" not found in ${BOARD}`);
  return doc.replace(re, `$1\n${body}\n$2`);
}

// ── 1. Feedback wall ──────────────────────────────────────────────────────
const open = await sql`
  SELECT f.category, f.summary, f.status, f.created_at, p.name AS project
  FROM platform_feedback f LEFT JOIN projects p ON p.id = f.project_id
  WHERE f.status IN ('new','planned')
    AND (p.name IS NULL OR p.name NOT ILIKE 'smoke%')
  ORDER BY f.status, f.created_at`;

// Group loosely by opening words so REPEAT reports are visible — two unrelated
// testers hitting the same thing is the strongest prioritisation signal we get.
const themes = new Map();
for (const r of open) {
  const key = r.summary
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");
  themes.set(key, (themes.get(key) ?? 0) + 1);
}
const repeats = [...themes.values()].filter((n) => n > 1).length;

const wallRows = open.map((r) => {
  const when = r.created_at.toISOString().slice(5, 10);
  const proj = (r.project ?? "?").slice(0, 14);
  const sum = r.summary.length > 90 ? r.summary.slice(0, 87) + "…" : r.summary;
  return `| ${r.status === "new" ? "⬜" : "🗓️"} | ${when} | ${proj} | ${r.category} | ${sum} |`;
});

const wall = [
  `_${open.length} open (${open.filter((r) => r.status === "new").length} new, ` +
    `${open.filter((r) => r.status === "planned").length} planned) · ` +
    `${repeats} theme(s) reported more than once · ` +
    `snapshot ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z_`,
  "",
  "| | date | project | kind | item |",
  "|---|---|---|---|---|",
  ...wallRows,
].join("\n");

const counts = await sql`
  SELECT f.status, count(*)::int AS n FROM platform_feedback f
  JOIN projects p ON p.id = f.project_id
  WHERE p.name NOT ILIKE 'smoke%' GROUP BY f.status ORDER BY f.status`;
const health = `_Wall totals: ${counts.map((c) => `${c.status}=${c.n}`).join(" · ")}_`;

// ── 2. Backlog ────────────────────────────────────────────────────────────
const ITEM = /^\|\s*([A-Z]+-\d+)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*(?:\*\*)?([HML-])(?:\*\*)?\s*\|/;
const bl = [];
for (const line of readFileSync("docs/BACKLOG.md", "utf8").split(/\r?\n/)) {
  const m = ITEM.exec(line);
  if (!m) continue;
  const status = m[3];
  if (status.includes("Shipped")) continue; // done — not pending work
  const mark = status.includes("Parked")
    ? "🅿️"
    : status.includes("Phased")
      ? "🗓️"
      : status.includes("progress")
        ? "🚧"
        : "📥";
  bl.push({ id: m[1], pri: m[4], mark, text: m[2].replace(/\*\*/g, "").slice(0, 88) });
}
const rank = { H: 0, M: 1, L: 2, "-": 3 };
bl.sort((a, b) => (rank[a.pri] ?? 3) - (rank[b.pri] ?? 3) || a.id.localeCompare(b.id));
const high = bl.filter((b) => b.pri === "H");

const backlogBlock = [
  `_${bl.length} unshipped (${high.length} high priority) · full detail in [../BACKLOG.md](../BACKLOG.md)_`,
  "",
  "**These are NOT started.** A sprint is a commitment; this is a list. High priority only:",
  "",
  "| | ID | item |",
  "|---|---|---|",
  ...high.map((b) => `| ${b.mark} | **${b.id}** | ${b.text} |`),
  "",
  `_…plus ${bl.length - high.length} at M/L priority._`,
].join("\n");

// ── write ─────────────────────────────────────────────────────────────────
let doc = readFileSync(BOARD, "utf8");
doc = replaceBlock(doc, "WALLHEALTH", health);
doc = replaceBlock(doc, "WALL", wall);
doc = replaceBlock(doc, "BACKLOG", backlogBlock);
writeFileSync(BOARD, doc);

console.log(
  `pm: refreshed ${BOARD} — wall ${open.length} open (${repeats} repeat theme[s]), ` +
    `backlog ${bl.length} unshipped (${high.length} high)`,
);
