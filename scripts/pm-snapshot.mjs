/**
 * Regenerate the live sections of docs/pm/BOARD.md from real state.
 *
 * The board's hand-written tracks are preserved; only the marked blocks are
 * replaced. This exists because the feedback wall is the highest-signal source
 * of work AND the easiest to let rot — on 2026-07-25 it read 20 open when 18
 * were already fixed. A board you have to query a database to trust is a board
 * nobody reads.
 *
 *   npm run pm
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync, writeFileSync } from "node:fs";

const BOARD = "docs/pm/BOARD.md";
const sql = neon(process.env.DATABASE_URL);

/** Replace the text between <!-- BEGIN:x --> and <!-- END:x --> markers. */
function replaceBlock(doc, name, body) {
  const re = new RegExp(`(<!-- BEGIN:${name} -->)[\\s\\S]*?(<!-- END:${name} -->)`);
  if (!re.test(doc)) throw new Error(`marker block "${name}" not found in ${BOARD}`);
  return doc.replace(re, `$1\n${body}\n$2`);
}

const open = await sql`
  SELECT f.id, f.category, f.summary, f.status, f.created_at, p.name AS project
  FROM platform_feedback f LEFT JOIN projects p ON p.id = f.project_id
  WHERE f.status IN ('new','planned')
    AND (p.name IS NULL OR p.name NOT ILIKE 'smoke%')
  ORDER BY f.status, f.created_at`;

// Group by summary-ish so repeat reports are visible — the single most useful
// prioritisation signal we have.
const byTheme = new Map();
for (const r of open) {
  const key = r.summary.toLowerCase().replace(/[^a-z ]/g, "").split(" ").slice(0, 6).join(" ");
  if (!byTheme.has(key)) byTheme.set(key, []);
  byTheme.get(key).push(r);
}
const repeats = [...byTheme.values()].filter((g) => g.length > 1).length;

const rows = open.map((r) => {
  const when = r.created_at.toISOString().slice(5, 10);
  const proj = (r.project ?? "?").slice(0, 14);
  const sum = r.summary.length > 92 ? r.summary.slice(0, 89) + "…" : r.summary;
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
  ...rows,
].join("\n");

const counts = await sql`
  SELECT f.status, count(*)::int AS n FROM platform_feedback f
  JOIN projects p ON p.id = f.project_id
  WHERE p.name NOT ILIKE 'smoke%' GROUP BY f.status ORDER BY f.status`;
const health = `_Wall totals: ${counts.map((c) => `${c.status}=${c.n}`).join(" · ")}_`;

let doc = readFileSync(BOARD, "utf8");
doc = replaceBlock(doc, "WALL", wall);
doc = replaceBlock(doc, "WALLHEALTH", health);
writeFileSync(BOARD, doc);

console.log(`pm: refreshed ${BOARD} — ${open.length} open wall items, ${repeats} repeat theme(s)`);
