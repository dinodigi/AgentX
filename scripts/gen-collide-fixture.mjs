/**
 * Emit a test fixture from a real project's relational shape.
 *
 * Node height is a function of FIELD COUNT, and edge-label positions derive from
 * node height — so a fixture that keeps only the relation fields does not
 * reproduce the geometry that made two labels overlap. This keeps each
 * collection's real field count (relations by name, the rest as filler) so the
 * layout is identical to the live one, then reports whether the fixture actually
 * collides. A fixture that does not collide cannot test a de-collision pass.
 */
import { neon } from "@neondatabase/serverless";
import { layoutSchemaMap } from "../lib/schema-map.ts";

const sql = neon(process.env.DATABASE_URL);
const projectId = process.argv[2];
if (!projectId) {
  console.error("usage: node --env-file=.env scripts/gen-collide-fixture.mjs <projectId>");
  process.exit(1);
}

const rows = await sql`SELECT name, fields FROM collections WHERE project_id = ${projectId}`;
const fixture = rows.map((c) => {
  const all = c.fields ?? [];
  const rels = all.filter((f) => f.type === "relation");
  const fillers = all.length - rels.length;
  return {
    name: c.name,
    fields: [
      ...Array.from({ length: fillers }, (_, i) => ({ name: `f${i}`, type: "text" })),
      ...rels.map((f) => ({ name: f.name, type: "relation", targetCollection: f.targetCollection })),
    ],
  };
});

const L = layoutSchemaMap(fixture);
const clash = [];
for (let i = 0; i < L.edges.length; i++) {
  for (let j = i + 1; j < L.edges.length; j++) {
    const a = L.edges[i];
    const b = L.edges[j];
    if (Math.abs(a.labelX - b.labelX) < 34 && Math.abs(a.labelY - b.labelY) < 12) clash.push([a, b]);
  }
}
console.log(`fixture: ${fixture.length} collections, ${L.edges.length} edges`);
console.log(`collisions WITH the pass active: ${clash.length}`);
for (const [a, b] of clash) console.log(`  ${a.from}.${a.field} vs ${b.from}.${b.field}`);

// Only the collections that participate in an edge are needed — trim the rest so
// the fixture stays readable.
const involved = new Set();
for (const e of L.edges) {
  involved.add(e.from);
  involved.add(e.to);
}
const trimmed = fixture.filter((c) => involved.has(c.name));
console.log(`\n// ${trimmed.length} collections participate in a relation`);
console.log(
  "const REAL_SHAPE = " +
    JSON.stringify(
      trimmed.map((c) => ({
        name: c.name,
        fields: c.fields.map((f) =>
          f.type === "relation" ? { name: f.name, type: "relation", targetCollection: f.targetCollection } : { name: f.name, type: "text" },
        ),
      })),
    ) +
    ";",
);
