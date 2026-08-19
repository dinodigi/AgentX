/**
 * Schema map — the project's content model as a graph, laid out deterministically.
 *
 * WHY THIS IS CHEAP FOR US. A schema view normally means parsing source code and
 * inferring a model from type definitions. Ours does not: a collection IS a row,
 * its `fields` are declared data, and a `relation` field already carries
 * `targetCollection` — validated at define time, so the edges are trustworthy
 * rather than guessed. The map is a read plus a layout pass; there is no parser
 * and no build step to keep working.
 *
 * WHAT THAT BUYS THAT A CODE-DERIVED MAP CANNOT HAVE. Because the declaration
 * also holds `publicRead`, `access`, `indexed`, `unique` and `searchable`, the
 * same picture can show the AUTHORIZATION BOUNDARY. `mode: "public"` draws only
 * what the delivery API would actually serve to an anonymous caller — an ER
 * diagram becomes a security review, and "which of my collections are exposed?"
 * stops being a question you answer by reading code.
 *
 * PURITY IS DELIBERATE. No imports, no `@/` aliases, only erasable TypeScript —
 * so the layout can be imported and asserted directly by the smoke suite rather
 * than tested through a rendered page behind Clerk. Layout bugs are silent
 * (a diagram is always *a* diagram), which is exactly the class of defect that
 * needs a real test.
 */

// ---------------------------------------------------------------- input shapes

/** The subset of a field definition the map needs. */
export interface MapField {
  name: string;
  type: string;
  /** For `relation` fields: the collection it points at. */
  targetCollection?: string;
  unique?: boolean;
  indexed?: boolean;
  searchable?: boolean;
  publicRead?: boolean;
}

/** The subset of a collection the map needs. */
export interface MapCollection {
  name: string;
  fields: MapField[];
  /** True when the collection carries any `access` rule. */
  hasAccessRules?: boolean;
  /** True when anonymous writes are allowed (an intake form). */
  publicWrite?: boolean;
}

/**
 * `model` draws the whole content model. `public` draws only what the delivery
 * API serves anonymously — collections with at least one publicRead field, and
 * within them only those fields.
 */
export type MapMode = "model" | "public";

// ---------------------------------------------------------------- output shapes

/** How a collection is exposed on the delivery API — encoded on the node. */
export type Exposure = "public" | "intake" | "private";

export interface MapNode {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 = references nothing; higher = further from the leaves. */
  layer: number;
  /** Rows actually drawn (capped — see FIELD_ROW_CAP). */
  rows: MapField[];
  /** How many fields were not drawn. */
  hiddenFields: number;
  exposure: Exposure;
  hasAccessRules: boolean;
}

export interface MapEdge {
  from: string;
  to: string;
  /** The relation field that owns this edge — the only honest edge label. */
  field: string;
  /** SVG path data, source right edge to target left edge. */
  path: string;
  labelX: number;
  labelY: number;
}

export interface SchemaMapLayout {
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  height: number;
  /** Collections omitted in `public` mode because nothing in them is readable. */
  omitted: string[];
  /**
   * Collections whose relation edges form a cycle. Recorded rather than hidden:
   * a cycle is legal in our schema (two collections may point at each other) and
   * the layout must still terminate, so those edges are drawn but the layering
   * of one side is arbitrary. Surfacing it beats a diagram that quietly lies.
   */
  cycles: string[];
}

// ---------------------------------------------------------------- geometry

const NODE_W = 178;
const HEADER_H = 24;
const ROW_H = 15;
const NODE_PAD_BOTTOM = 9;
const COL_GAP = 58;
const ROW_GAP = 26;
const MARGIN_X = 16;
const MARGIN_Y = 20;
/** Two edge labels closer than this in BOTH axes are unreadable. */
const LABEL_MIN_DX = 34;
const LABEL_MIN_DY = 12;
/** Beyond this, a node lists a "+N more" line instead of growing unboundedly. */
const FIELD_ROW_CAP = 8;

const nodeHeight = (rowCount: number, hasMore: boolean): number =>
  HEADER_H + (rowCount + (hasMore ? 1 : 0)) * ROW_H + NODE_PAD_BOTTOM;

// ---------------------------------------------------------------- helpers

const isRelation = (f: MapField): boolean => f.type === "relation" && typeof f.targetCollection === "string";

function exposureOf(c: MapCollection): Exposure {
  if (c.fields.some((f) => f.publicRead === true)) return "public";
  if (c.publicWrite === true) return "intake";
  return "private";
}

/**
 * Layer = distance from a leaf, where a leaf references no other collection.
 * Referrers end up on the LEFT and their targets on the RIGHT, so every arrow
 * points the same way and the eye can follow a dependency without tracing.
 *
 * Cycle-safe by construction: a node already being resolved contributes nothing
 * to its own depth, so a mutual reference terminates instead of recursing.
 */
function assignLayers(cols: MapCollection[]): { layers: Map<string, number>; cycles: string[] } {
  const byName = new Map(cols.map((c) => [c.name, c]));
  const layers = new Map<string, number>();
  const resolving = new Set<string>();
  const cycles = new Set<string>();

  const depth = (name: string): number => {
    const cached = layers.get(name);
    if (cached !== undefined) return cached;
    if (resolving.has(name)) {
      cycles.add(name);
      return 0; // break the cycle; the edge is still drawn
    }
    const col = byName.get(name);
    if (!col) return 0;
    resolving.add(name);
    let d = 0;
    for (const f of col.fields) {
      if (!isRelation(f)) continue;
      const target = f.targetCollection as string;
      if (target === name || !byName.has(target)) continue; // self-ref / external
      d = Math.max(d, 1 + depth(target));
    }
    resolving.delete(name);
    layers.set(name, d);
    return d;
  };

  // Sorted so the traversal order — and therefore which side of a cycle gets the
  // arbitrary layer — is stable across runs.
  for (const c of [...cols].sort((a, b) => a.name.localeCompare(b.name))) depth(c.name);
  return { layers, cycles: [...cycles].sort() };
}

// ---------------------------------------------------------------- layout

export function layoutSchemaMap(collections: MapCollection[], mode: MapMode = "model"): SchemaMapLayout {
  const omitted: string[] = [];

  // In public mode, keep only what the delivery API would serve anonymously.
  // NOTE (v1, stated rather than implied): this reads TOP-LEVEL publicRead only.
  // Inside a public container, sub-fields are public by default and opt out with
  // publicRead:false — the map collapses containers, so it shows that the
  // container is exposed without enumerating which leaves within it are.
  let cols: MapCollection[] = collections;
  if (mode === "public") {
    cols = [];
    for (const c of collections) {
      const publicFields = c.fields.filter((f) => f.publicRead === true);
      if (publicFields.length === 0) {
        omitted.push(c.name);
        continue;
      }
      cols.push({ ...c, fields: publicFields });
    }
    omitted.sort();
  }

  const { layers, cycles } = assignLayers(cols);
  const maxLayer = cols.reduce((m, c) => Math.max(m, layers.get(c.name) ?? 0), 0);

  // Group by column. x is mirrored so the HIGHEST layer sits leftmost.
  const columns: MapCollection[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const c of [...cols].sort((a, b) => a.name.localeCompare(b.name))) {
    columns[layers.get(c.name) ?? 0].push(c);
  }

  const nodes: MapNode[] = [];
  const byName = new Map<string, MapNode>();
  let height = 0;

  for (let layer = 0; layer <= maxLayer; layer++) {
    const x = MARGIN_X + (maxLayer - layer) * (NODE_W + COL_GAP);
    let y = MARGIN_Y;
    for (const c of columns[layer]) {
      const rows = c.fields.slice(0, FIELD_ROW_CAP);
      const hiddenFields = Math.max(0, c.fields.length - rows.length);
      const h = nodeHeight(rows.length, hiddenFields > 0);
      const node: MapNode = {
        name: c.name,
        x,
        y,
        w: NODE_W,
        h,
        layer,
        rows,
        hiddenFields,
        exposure: exposureOf(c),
        hasAccessRules: c.hasAccessRules === true,
      };
      nodes.push(node);
      byName.set(c.name, node);
      y += h + ROW_GAP;
      height = Math.max(height, y);
    }
  }

  // Edges: one per relation field, in a stable order.
  const edges: MapEdge[] = [];
  for (const c of [...cols].sort((a, b) => a.name.localeCompare(b.name))) {
    const src = byName.get(c.name);
    if (!src) continue;
    const rels = c.fields.filter(isRelation);
    rels.forEach((f, i) => {
      const target = f.targetCollection as string;
      if (target === c.name) return; // a self-edge has no two endpoints to draw
      // `byName` holds only DRAWN nodes, so this one guard covers both a dangling
      // target and one omitted by public mode. An arrow to nowhere is worse than
      // no arrow, and a negative control proved a second check here was dead code.
      const dst = byName.get(target);
      if (!dst) return;

      // Anchor each edge at a distinct height on the source so parallel edges
      // between the same pair of columns stay distinguishable.
      const spread = src.h / (rels.length + 1);
      const y1 = src.y + spread * (i + 1);
      const x1 = src.x + src.w;
      const x2 = dst.x;
      const y2 = dst.y + dst.h / 2;
      const bend = Math.max(28, (x2 - x1) / 2);
      edges.push({
        from: c.name,
        to: target,
        field: f.name,
        path: `M ${round(x1)} ${round(y1)} C ${round(x1 + bend)} ${round(y1)} ${round(x2 - bend)} ${round(y2)} ${round(x2)} ${round(y2)}`,
        // Placed at ~a third of the way along rather than the midpoint: source
        // anchors are already spread by edge index, so staying near them keeps
        // labels apart, while midpoints converge wherever several edges do.
        labelX: round(x1 + (x2 - x1) * 0.32),
        labelY: round(y1 + (y2 - y1) * 0.2 - 4),
      });
    });
  }

  // De-collide labels. Greedy and order-stable: walk them in a fixed order and
  // push any that lands on top of an already-placed one downward until clear.
  // Bounded, so a pathological schema degrades to slight overlap rather than
  // looping. Found by rendering a real 17-collection schema and looking at it —
  // every unit test passed while two labels sat one pixel apart.
  const placed: { x: number; y: number }[] = [];
  const collides = (x: number, y: number): boolean =>
    placed.some((q) => Math.abs(q.x - x) < LABEL_MIN_DX && Math.abs(q.y - y) < LABEL_MIN_DY);
  for (const e of [...edges].sort((a, b) => a.labelX - b.labelX || a.labelY - b.labelY || a.field.localeCompare(b.field))) {
    let tries = 0;
    while (collides(e.labelX, e.labelY) && tries < 8) {
      e.labelY = round(e.labelY + LABEL_MIN_DY);
      tries++;
    }
    placed.push({ x: e.labelX, y: e.labelY });
  }

  const width = MARGIN_X * 2 + (maxLayer + 1) * NODE_W + maxLayer * COL_GAP;
  return {
    nodes,
    edges,
    width: Math.max(width, 320),
    height: Math.max(height - ROW_GAP + MARGIN_Y, 120),
    omitted,
    cycles,
  };
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** One-line summary for the page header — derived, never typed. */
export function summarize(layout: SchemaMapLayout): string {
  const exposed = layout.nodes.filter((n) => n.exposure === "public").length;
  const intake = layout.nodes.filter((n) => n.exposure === "intake").length;
  const parts = [
    `${layout.nodes.length} ${layout.nodes.length === 1 ? "collection" : "collections"}`,
    `${layout.edges.length} ${layout.edges.length === 1 ? "relation" : "relations"}`,
  ];
  if (exposed > 0) parts.push(`${exposed} publicly readable`);
  if (intake > 0) parts.push(`${intake} accepting anonymous writes`);
  return parts.join(" · ");
}
