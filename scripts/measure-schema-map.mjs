/**
 * Quantify how readable a schema map is, so "less tangled" is a measurement
 * rather than an opinion. Reports the three things that actually made the first
 * version hard to read on a 25-collection project:
 *
 *   1. aspect ratio        — portrait means it runs off the bottom of a screen
 *   2. arrival spread      — every edge aiming at one point on a hub is the fan
 *   3. node crossings      — an edge passing through an unrelated node
 *
 *   node --env-file=.env scripts/measure-schema-map.mjs <projectId...>
 */
import { neon } from "@neondatabase/serverless";
import { layoutSchemaMap } from "../lib/schema-map.ts";

const sql = neon(process.env.DATABASE_URL);
const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: node --env-file=.env scripts/measure-schema-map.mjs <projectId...>");
  process.exit(1);
}

/** Sample a cubic bezier from its SVG path data. */
function samples(path, n = 40) {
  const nums = path.match(/-?[\d.]+/g).map(Number);
  const [x0, y0, x1, y1, x2, y2, x3, y3] = nums;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    ]);
  }
  return out;
}

for (const id of ids) {
  const [proj] = await sql`SELECT name FROM projects WHERE id = ${id}`;
  if (!proj) {
    console.log(`${id}: no such project`);
    continue;
  }
  const rows = await sql`SELECT name, fields, access, public_write FROM collections WHERE project_id = ${id}`;
  const L = layoutSchemaMap(
    rows.map((c) => ({
      name: c.name,
      publicWrite: c.public_write === true,
      hasAccessRules: c.access != null && Object.keys(c.access).length > 0,
      fields: (c.fields ?? []).map((f) => ({
        name: f.name,
        type: f.type,
        targetCollection: f.type === "relation" ? f.targetCollection : undefined,
        publicRead: f.publicRead === true,
      })),
    })),
  );

  // 2. arrival spread on the busiest target.
  const arrivals = new Map();
  for (const e of L.edges) {
    const list = arrivals.get(e.to) ?? [];
    // the path's final coordinate pair is the arrival point
    const n = e.path.match(/-?[\d.]+/g).map(Number);
    list.push(n[n.length - 1]);
    arrivals.set(e.to, list);
  }
  let hub = null;
  for (const [name, ys] of arrivals) if (!hub || ys.length > hub[1].length) hub = [name, ys];
  const distinct = hub ? new Set(hub[1].map((y) => Math.round(y))).size : 0;

  // 3. crossings: an edge whose curve passes through a node it does not touch.
  let crossings = 0;
  for (const e of L.edges) {
    const pts = samples(e.path);
    for (const nd of L.nodes) {
      if (nd.name === e.from || nd.name === e.to) continue;
      if (pts.some(([x, y]) => x > nd.x && x < nd.x + nd.w && y > nd.y && y < nd.y + nd.h)) crossings++;
    }
  }

  const cols = new Set(L.nodes.map((n) => n.x)).size;
  console.log(`${proj.name}`);
  console.log(`  ${L.nodes.length} collections · ${L.edges.length} relations · ${cols} columns`);
  console.log(`  viewBox ${L.width}x${L.height}  aspect ${(L.width / L.height).toFixed(2)} ${L.width > L.height ? "(landscape)" : "(PORTRAIT — runs off screen)"}`);
  if (hub) console.log(`  busiest target "${hub[0]}": ${hub[1].length} arrivals at ${distinct} distinct points${distinct === 1 ? "  <-- THE FAN" : ""}`);
  console.log(`  edges crossing an unrelated node: ${crossings}`);
}
