/**
 * Render a real project's schema map to a standalone HTML file.
 *
 * A layout algorithm can pass every unit test and still draw something nobody
 * can read — labels colliding, a column taller than the screen, edges tangled
 * through five nodes. Those are judgement calls, not assertions, so this exists
 * to put the actual drawing in front of a human before it ships.
 *
 *   node --env-file=.env scripts/preview-schema-map.mjs <projectId> [public]
 */
import { neon } from "@neondatabase/serverless";
import { writeFileSync } from "node:fs";
import { layoutSchemaMap, summarize } from "../lib/schema-map.ts";

const sql = neon(process.env.DATABASE_URL);
const [projectId, modeArg] = process.argv.slice(2);
if (!projectId) {
  console.error("usage: node --env-file=.env scripts/preview-schema-map.mjs <projectId> [public]");
  process.exit(1);
}
const mode = modeArg === "public" ? "public" : "model";
const density = process.argv[4] === "detailed" || modeArg === "detailed" ? "detailed" : "compact";

const [proj] = await sql`SELECT name FROM projects WHERE id = ${projectId}`;
if (!proj) {
  console.error("no such project");
  process.exit(1);
}
const rows = await sql`SELECT name, fields, access, public_write FROM collections WHERE project_id = ${projectId}`;

const input = rows.map((c) => ({
  name: c.name,
  publicWrite: c.public_write === true,
  hasAccessRules: c.access != null && Object.keys(c.access).length > 0,
  fields: (c.fields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    targetCollection: f.type === "relation" ? f.targetCollection : undefined,
    unique: f.unique === true,
    indexed: f.indexed === true,
    searchable: f.searchable === true,
    publicRead: f.publicRead === true,
  })),
}));

const L = layoutSchemaMap(input, mode, density);
const FILL = { public: "#a2571a", intake: "#0a6870", private: "#b4bfcb" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const nodeSvg = (n) => {
  const rows = n.rows
    .map((f, i) => {
      const y = n.y + 24 + 11 + i * 15;
      const rel = f.type === "relation";
      return `<text x="${n.x + 10}" y="${y}" font-size="10.5"><tspan fill="${
        rel ? "#0a6870" : "#10151c"
      }">${esc(f.name)}</tspan><tspan fill="#5c6675">  ${esc(f.type)}${f.unique ? " ◆" : ""}${
        f.indexed ? " ⌘" : ""
      }${f.searchable ? " ⌕" : ""}</tspan></text>`;
    })
    .join("");
  const more =
    n.hiddenFields > 0
      ? `<text x="${n.x + 10}" y="${n.y + 24 + 11 + n.rows.length * 15}" font-size="10.5" fill="#9aa5b1">${
          density === "compact" ? `${n.totalFields} fields` : `+ ${n.hiddenFields} more`
        }</text>`
      : "";
  return `<g>
  <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="4" fill="#fff" stroke="#b4bfcb"/>
  <rect x="${n.x}" y="${n.y}" width="${n.w}" height="24" rx="4" fill="#f2f5f8"/>
  <line x1="${n.x}" y1="${n.y + 24}" x2="${n.x + n.w}" y2="${n.y + 24}" stroke="#d9e0e8"/>
  <rect x="${n.x}" y="${n.y}" width="3.5" height="24" fill="${FILL[n.exposure]}"/>
  <text x="${n.x + 13}" y="${n.y + 16}" font-size="11.5" font-weight="700" fill="#10151c">${esc(n.name)}</text>
  ${n.hasAccessRules ? `<text x="${n.x + n.w - 8}" y="${n.y + 16}" font-size="9" text-anchor="end" fill="#9aa5b1">access</text>` : ""}
  ${rows}${more}
</g>`;
};

const html = `<!doctype html><meta charset="utf-8"><title>${esc(proj.name)} — schema map (${mode})</title>
<body style="margin:0;background:#fbfcfd;font-family:ui-sans-serif,system-ui,sans-serif;color:#10151c">
<div style="max-width:1400px;margin:0 auto;padding:32px 24px 64px">
  <h1 style="margin:0 0 4px;font-size:22px;letter-spacing:-.02em">${esc(proj.name)} — schema map</h1>
  <p style="margin:0 0 6px;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:#5c6675">${esc(
    summarize(L),
  )} · ${mode} / ${density} · viewBox ${L.width}×${L.height}</p>
  ${L.omitted.length ? `<p style="margin:0 0 6px;font-size:12.5px;color:#5c6675">not drawn: ${esc(L.omitted.join(", "))}</p>` : ""}
  ${L.cycles.length ? `<p style="margin:0 0 6px;font-size:12.5px;color:#a2571a">cycles: ${esc(L.cycles.join(", "))}</p>` : ""}
  <div style="overflow:auto;border:1px solid #d9e0e8;border-radius:6px;background-color:#fbfcfd;background-image:radial-gradient(circle,#d9e0e8 1px,transparent 1px);background-size:24px 24px;margin-top:12px;max-height:78vh">
  <svg viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" height="${L.height}" style="display:block;font-family:ui-monospace,Consolas,monospace">
    <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="#0a6870"/></marker></defs>
    <g fill="none" stroke="#0a6870" stroke-width="1.25" opacity="0.75" marker-end="url(#a)">
      ${L.edges.map((e) => `<path d="${e.path}"/>`).join("\n      ")}
    </g>
    <g font-size="10" fill="#0a6870" paint-order="stroke" stroke="#fbfcfd" stroke-width="4" stroke-linejoin="round">
      ${L.edges.map((e) => `<text x="${e.labelX}" y="${e.labelY}" text-anchor="middle">${esc(e.field)}</text>`).join("\n      ")}
    </g>
    ${L.nodes.map(nodeSvg).join("\n    ")}
  </svg>
  </div>
</div>`;

const out = `schema-map-${density}.html`;
writeFileSync(out, html, "utf8");
console.log(`${proj.name}: ${summarize(L)}`);
console.log(`  mode=${mode} viewBox=${L.width}x${L.height} nodes=${L.nodes.length} edges=${L.edges.length}`);
if (L.omitted.length) console.log(`  omitted: ${L.omitted.join(", ")}`);
if (L.cycles.length) console.log(`  cycles: ${L.cycles.join(", ")}`);
console.log(`  wrote ${out}`);
