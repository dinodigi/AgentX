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
import { execFileSync } from "node:child_process";

const BOARD = "docs/pm/BOARD.md";
const sql = neon(process.env.DATABASE_URL);

/** git plumbing, quiet on failure (a shallow clone or missing git must not kill the snapshot). */
function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function replaceBlock(doc, name, body) {
  const re = new RegExp(`(<!-- BEGIN:${name} -->)[\\s\\S]*?(<!-- END:${name} -->)`);
  if (!re.test(doc)) throw new Error(`marker block "${name}" not found in ${BOARD}`);
  return doc.replace(re, `$1\n${body}\n$2`);
}

// ── 1. Feedback wall ──────────────────────────────────────────────────────
const open = await sql`
  SELECT f.id, f.category, f.summary, f.status, f.created_at, p.name AS project
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
// CP10: every row carries a disposition, and this parse VERIFIES the discipline
// instead of trusting it — this doc has gone stale in the flattering direction
// four times, always the same way (shipped work, silent row). Three mechanical
// checks close most of that gap:
//   (a) every commit hash cited in a ✅ row must exist in git — a receipt that
//       points nowhere is not a receipt;
//   (b) for every still-scheduled item id, search git history for commits that
//       NAME it — a commit subject saying "AUTO-1" while the row reads open is
//       exactly the staleness that sat unnoticed for four days. Warnings, not
//       failures: commits may mention an id in passing.
//   (c) shape: a ⏳ row must carry an observable "TRIGGER:", and 🅿️ is retired.
const ITEM = /^\|\s*([A-Z]+-\d+)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*(?:\*\*)?([HML\-—])(?:\*\*)?\s*\|/;
const bl = [];
const shippedRows = [];
const warnings = [];
for (const line of readFileSync("docs/BACKLOG.md", "utf8").split(/\r?\n/)) {
  const m = ITEM.exec(line);
  if (!m) continue;
  const status = m[3];
  const row = { id: m[1], pri: m[4], text: m[2].replace(/\*\*/g, "").slice(0, 88), raw: line };
  if (status.includes("Shipped")) {
    shippedRows.push(row);
    continue; // done — not pending work
  }
  row.mark = status.includes("Trigger")
    ? "⏳"
    : status.includes("Declined")
      ? "🚫"
      : status.includes("Operator")
        ? "⚑"
        : status.includes("Parked")
          ? "🅿️"
          : status.includes("Phased")
            ? "🗓️"
            : status.includes("progress")
              ? "🚧"
              : "📥";
  bl.push(row);
}

// (a) cited hashes resolve to real commits (shipped rows AND ship-notes in open
// rows). Wall-item ids also appear in backticks and are hex-shaped — resolve
// against the feedback table before calling one a dangling receipt.
const wallIdPrefixes = new Set(
  (await sql`SELECT left(id::text, 8) AS p FROM platform_feedback`).map((r) => r.p),
);
const seen = new Set();
for (const r of [...shippedRows, ...bl]) {
  for (const [, hash] of r.raw.matchAll(/`([0-9a-f]{7,10})`/g)) {
    const key = `${r.id}:${hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (wallIdPrefixes.has(hash.slice(0, 8))) continue; // a wall-item reference, not a commit
    if (git("cat-file", "-e", `${hash}^{commit}`) === null) {
      warnings.push(`${r.id}: cites commit \`${hash}\`, which does not exist in this clone`);
    }
  }
}
// (b) the silent-ship detector — only for rows still claiming to be pending
// work, and only against commit SUBJECTS. A subject that names an id ("Track B /
// AUTO-1") is a ship signal; a body mention is usually context, and the first
// run of this check proved bodies are all noise (docs commits editing this very
// file trip it).
const subjects = (git("log", "--all", "--format=%h %s") ?? "").split("\n");
/** Does this commit change RUNTIME code (lib/app/db)? docs/ commits are the
 *  entries that CREATE rows; scripts/ commits are board tooling and receipts
 *  (wall-resolve, pm-snapshot) — a receipts commit whose subject NAMES the id it
 *  is closing tripped this check the first week it existed. A real ship always
 *  touches lib/, app/, or db/. */
const touchesCode = (hash) =>
  ((git("show", "--name-only", "--format=", hash) ?? "").split("\n")).some(
    (f) => f.trim() && !f.startsWith("docs/") && !f.startsWith("scripts/"),
  );
for (const r of bl) {
  if (r.mark !== "📥" && r.mark !== "🚧" && r.mark !== "🗓️") continue;
  const re = new RegExp(`\\b${r.id}\\b`, "i");
  const hits = subjects.filter((s) => re.test(s) && touchesCode(s.split(" ")[0]));
  if (hits.length) {
    warnings.push(
      `${r.id}: reads ${r.mark} but commit subject(s) name it — verify and reconcile:\n      ${hits.slice(0, 3).join("\n      ")}`,
    );
  }
}
// (c) disposition shape.
for (const r of bl) {
  if (r.mark === "⏳" && !/TRIGGER:/.test(r.raw)) {
    warnings.push(`${r.id}: ⏳ without a named "TRIGGER:" — "later" is not a trigger (BURNDOWN)`);
  }
  if (r.mark === "🚫" && !/—|because|reason/i.test(r.raw)) {
    warnings.push(`${r.id}: 🚫 without a written reason — an unexplained decline comes back as a report`);
  }
  if (r.mark === "🅿️") {
    warnings.push(`${r.id}: 🅿️ Parked is retired (CP10) — give it a trigger, a decline, or schedule it`);
  }
}
const rank = { H: 0, M: 1, L: 2, "-": 3 };
bl.sort((a, b) => (rank[a.pri] ?? 3) - (rank[b.pri] ?? 3) || a.id.localeCompare(b.id));
// CP10: the number that matters is the SCHEDULED work (📥/🚧/🗓️), not the raw
// row count — ⏳/⚑ rows are closed-with-a-condition, and folding them into one
// headline made the backlog look permanently amber.
const scheduled = bl.filter((b) => b.mark === "📥" || b.mark === "🚧" || b.mark === "🗓️");
const waiting = bl.filter((b) => b.mark === "⏳" || b.mark === "⚑");
const high = scheduled.filter((b) => b.pri === "H");

const backlogBlock = [
  `_${scheduled.length} scheduled (${high.length} high) · ${waiting.length} closed-with-a-condition (⏳ trigger / ⚑ operator) · full detail in [../BACKLOG.md](../BACKLOG.md)_`,
  "",
  "**Scheduled = decided, not started.** A sprint is a commitment; this is a list. High priority:",
  "",
  "| | ID | item |",
  "|---|---|---|",
  ...high.map((b) => `| ${b.mark} | **${b.id}** | ${b.text} |`),
  "",
  `_…plus ${scheduled.length - high.length} scheduled at M/L, and ${waiting.length} ⏳/⚑ rows that reopen on their named condition._`,
].join("\n");

// ── write ─────────────────────────────────────────────────────────────────
let doc = readFileSync(BOARD, "utf8");
doc = replaceBlock(doc, "WALLHEALTH", health);
doc = replaceBlock(doc, "WALL", wall);
doc = replaceBlock(doc, "BACKLOG", backlogBlock);

// ── Burn-down ledger ──────────────────────────────────────────────────────
// Every CLOSED item with the receipt we wrote back to the reporter. This used
// to be a hand-kept table and drifted within a single session, so it is derived
// from the same rows the reporter reads.
const closed = await sql`
  SELECT f.id, f.summary, f.detail, p.name AS project, f.status
  FROM platform_feedback f LEFT JOIN projects p ON p.id = f.project_id
  WHERE f.status = 'done'
    AND (p.name IS NULL OR p.name NOT ILIKE 'smoke%')
    AND f.detail LIKE '%---%**%'
  ORDER BY f.created_at`;

const RECEIPT = /---\n\*\*(SHIPPED|ANSWERED|DECLINED|TRIGGER)\*\* ([0-9-]+) · `([^`]*)`/;
const MARK = { SHIPPED: "✅", ANSWERED: "📝", DECLINED: "🚫", TRIGGER: "⏳" };
const ledgerRows = [];
for (const r of closed) {
  const m = RECEIPT.exec(r.detail ?? "");
  if (!m) continue;
  const [, disposition, , ref] = m;
  ledgerRows.push(
    `| ${MARK[disposition] ?? "•"} | \`${String(r.id).slice(0, 8)}\` | ${String(r.project ?? "—")} | ${r.summary.replace(/\s+/g, " ").replace(/\|/g, "\|").slice(0, 110)} | ${disposition === "TRIGGER" ? `reopens: ${ref}` : `\`${ref}\``} |`,
  );
}
const ledger = ledgerRows.length
  ? [
      `_${ledgerRows.length} closed with a receipt the reporter can read. ✅ shipped · 📝 answered · ⏳ deferred with a trigger · 🚫 declined._`,
      "",
      "| | id | project | item | receipt |",
      "|---|---|---|---|---|",
      ...ledgerRows,
    ].join("\n")
  : "_Nothing closed with a receipt yet._";
doc = replaceBlock(doc, "LEDGER", ledger);
writeFileSync(BOARD, doc);

// ── burn-down progress ────────────────────────────────────────────────────
// Two numbers, because one would mislead. COUNT flatters us — the cheap items
// were batched first on purpose. EFFORT is the honest one: it weights each item
// by the size tagged in QUEUE.md, so the percentage does not appear to stall
// later when the burn-down is really just meeting the bigger work.
const WEIGHT = { S: 1, M: 3, L: 8 };
const queueDoc = readFileSync(new URL("../docs/pm/QUEUE.md", import.meta.url), "utf8");
const sizeBlock = queueDoc.match(/<!-- SIZES([\s\S]*?)-->/);
const sizes = new Map();
if (sizeBlock) {
  for (const [, id, sz] of sizeBlock[1].matchAll(/([0-9a-f]{8})\s+([SML])\b/g)) {
    sizes.set(id, WEIGHT[sz]);
  }
}

// Anything tagged but no longer open has been closed. An open item with no tag
// is counted at M rather than skipped — an untagged item must never be free.
const openIds = new Set(open.map((o) => String(o.id).slice(0, 8)));
let doneEffort = 0;
let openEffort = 0;
let doneCount = 0;
for (const [id, w] of sizes) {
  if (openIds.has(id)) { openEffort += w; } else { doneEffort += w; doneCount++; }
}
for (const o of open) {
  if (!sizes.has(String(o.id).slice(0, 8))) openEffort += WEIGHT.M;
}
const totalEffort = doneEffort + openEffort;
const totalCount = doneCount + open.length;
const pct = (a, b) => (b === 0 ? 100 : Math.round((a / b) * 100));

const bar = (p) => "█".repeat(Math.round(p / 5)).padEnd(20, "░");

console.log(
  `pm: refreshed ${BOARD} — wall ${open.length} open (${repeats} repeat theme[s]), ` +
    `backlog ${scheduled.length} scheduled + ${waiting.length} on-trigger (${high.length} high)`,
);
console.log("");
console.log(`  FEEDBACK WALL   ${bar(pct(doneEffort, totalEffort))}  ${pct(doneEffort, totalEffort)}% by effort`);
console.log(`                  ${doneCount}/${totalCount} items closed (${pct(doneCount, totalCount)}% by count) · ${doneEffort}/${totalEffort} effort points`);
// Dispositioned% — every row in a decided state (anything but 🅿️). The bar the
// old line reserved for "await CP10" now reports the sweep's actual output.
const decided = bl.filter((b) => b.mark !== "🅿️").length;
console.log(
  `  BACKLOG         ${bar(pct(decided, bl.length))}  ${pct(decided, bl.length)}% dispositioned — ` +
    `${scheduled.length} 📥 scheduled · ${bl.filter((b) => b.mark === "⏳").length} ⏳ trigger · ` +
    `${bl.filter((b) => b.mark === "⚑").length} ⚑ operator · ${shippedRows.length} ✅ shipped`,
);
console.log("");
if (warnings.length) {
  console.log(`  \x1b[33m⚠ ${warnings.length} consistency warning(s) — the board may be lying again:\x1b[0m`);
  for (const w of warnings) console.log(`    - ${w}`);
  console.log("");
} else {
  console.log("  ✓ consistency: cited commits exist; no open row is named by a commit; every ⏳ has a trigger");
  console.log("");
}
console.log(
  `  Remaining wall work is ${openEffort} points across ${open.length} items ` +
    `(avg ${(openEffort / Math.max(open.length, 1)).toFixed(1)} vs ${(doneEffort / Math.max(doneCount, 1)).toFixed(1)} for what is done) ` +
    `— the rest is heavier, by design.`,
);
