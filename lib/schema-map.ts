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

/**
 * How much of each collection to draw — an axis independent of `mode`.
 *
 * `compact` is the default and draws STRUCTURE: the relation fields (which are
 * the edges) plus a count of everything else. `detailed` lists fields.
 *
 * This exists because node height drives the whole layout. Listing eight fields
 * per collection made every box ~150px tall, which on a 25-collection project
 * forced the columns to wrap, which in turn made 27 of 31 edges span two or more
 * columns — so most edges had to pass behind unrelated boxes, vanishing and
 * reappearing. Compact boxes shorten the columns, which shortens the edges,
 * which is the only thing that actually reduces the tangle.
 */
export type MapDensity = "compact" | "detailed";

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
  /** Rows actually drawn. */
  rows: MapField[];
  /** How many fields were not drawn. */
  hiddenFields: number;
  /** Total field count, so a compact node can still state its real size. */
  totalFields: number;
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

const NODE_W = 190;
const HEADER_H = 24;
const ROW_H = 15;
const NODE_PAD_BOTTOM = 9;
const COL_GAP = 96;
const ROW_GAP = 36;
const MARGIN_X = 24;
const MARGIN_Y = 24;
/**
 * A layer taller than this WRAPS into balanced sub-columns.
 *
 * Without it the map is a function of dependency depth alone, which on a real
 * 25-collection project put nine nodes in one column and ran ~1900px down the
 * page while two thirds of the canvas width sat empty. Wrapping trades height
 * for width, which is the axis a screen actually has.
 */
const WRAP_HEIGHT = 820;
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

export function layoutSchemaMap(
  collections: MapCollection[],
  mode: MapMode = "model",
  density: MapDensity = "compact",
): SchemaMapLayout {
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

  // Group by layer, alphabetically within it so the order is stable.
  const byLayer: MapCollection[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const c of [...cols].sort((a, b) => a.name.localeCompare(b.name))) {
    byLayer[layers.get(c.name) ?? 0].push(c);
  }

  const measure = (c: MapCollection) => {
    // Compact keeps the relations — they are the edges, so hiding them would make
    // the arrows unattributable — and summarises the rest as a count.
    const rows = density === "compact" ? c.fields.filter(isRelation) : c.fields.slice(0, FIELD_ROW_CAP);
    const hiddenFields = Math.max(0, c.fields.length - rows.length);
    return { c, rows, hiddenFields, totalFields: c.fields.length, h: nodeHeight(rows.length, hiddenFields > 0) };
  };
  type Measured = ReturnType<typeof measure>;

  // Build the column list, layers from highest to lowest so referrers stay LEFT
  // of what they reference. A layer taller than WRAP_HEIGHT splits into balanced
  // sub-columns; because every sub-column of a layer still precedes every column
  // of the next, the left-to-right invariant holds and arrows never turn back.
  const colGroups: { layer: number; items: Measured[] }[] = [];
  for (let layer = maxLayer; layer >= 0; layer--) {
    const items = byLayer[layer].map(measure);
    if (items.length === 0) continue;
    const total = items.reduce((sum, m) => sum + m.h + ROW_GAP, 0) - ROW_GAP;
    const chunks = Math.max(1, Math.ceil(total / WRAP_HEIGHT));
    const target = total / chunks;
    const perChunk: Measured[][] = Array.from({ length: chunks }, () => []);
    const filled = new Array(chunks).fill(0);
    let ci = 0;
    for (const m of items) {
      // Move on once this sub-column has taken its share, but never leave a
      // later one empty — that would reintroduce the unbalanced shape.
      if (filled[ci] > 0 && filled[ci] + m.h > target && ci < chunks - 1) ci++;
      perChunk[ci].push(m);
      filled[ci] += m.h + ROW_GAP;
    }
    for (const chunk of perChunk) if (chunk.length > 0) colGroups.push({ layer, items: chunk });
  }

  const nodes: MapNode[] = [];
  const byName = new Map<string, MapNode>();
  let height = 0;

  colGroups.forEach((group, ci) => {
    const x = MARGIN_X + ci * (NODE_W + COL_GAP);
    let y = MARGIN_Y;
    for (const m of group.items) {
      const node: MapNode = {
        name: m.c.name,
        x,
        y,
        w: NODE_W,
        h: m.h,
        layer: group.layer,
        rows: m.rows,
        hiddenFields: m.hiddenFields,
        totalFields: m.totalFields,
        exposure: exposureOf(m.c),
        hasAccessRules: m.c.hasAccessRules === true,
      };
      nodes.push(node);
      byName.set(m.c.name, node);
      y += m.h + ROW_GAP;
      height = Math.max(height, y);
    }
  });
  const columnCount = colGroups.length;

  // Edges, in two passes.
  //
  // Pass 1 fixes each edge's SOURCE anchor, spread down the source's right edge
  // so several relations from one collection stay distinguishable.
  //
  // Pass 2 fixes the TARGET anchors, and exists because the first version aimed
  // every incoming edge at dst.y + dst.h/2 — one single point. On a real project
  // fifteen relations pointed at `users`, so fifteen long curves converged into
  // one spot and swept across the whole canvas as an unreadable fan. Spreading
  // arrivals down the target's left edge, ordered by where they came from, keeps
  // them parallel instead of collapsing them together.
  interface Intent { from: string; to: string; field: string; x1: number; y1: number; }
  const intents: Intent[] = [];
  for (const c of [...cols].sort((a, b) => a.name.localeCompare(b.name))) {
    const src = byName.get(c.name);
    if (!src) continue;
    const rels = c.fields.filter(isRelation);
    rels.forEach((f, i) => {
      const target = f.targetCollection as string;
      if (target === c.name) return; // a self-edge has no two endpoints to draw
      // No target lookup here on purpose. Pass 2 skips any target that is not
      // drawn — dangling, or omitted by public mode — so a check here would be
      // unreachable. A negative control caught exactly that: the line could be
      // deleted and no test failed. One guard, and it is the one under test.
      const spread = src.h / (rels.length + 1);
      intents.push({ from: c.name, to: target, field: f.name, x1: src.x + src.w, y1: src.y + spread * (i + 1) });
    });
  }

  const incoming = new Map<string, Intent[]>();
  for (const it of intents) {
    const list = incoming.get(it.to) ?? [];
    list.push(it);
    incoming.set(it.to, list);
  }

  const edges: MapEdge[] = [];
  for (const [target, list] of [...incoming.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dst = byName.get(target);
    if (!dst) continue;
    // Sorted by where the edge comes FROM, so arrivals keep the same vertical
    // order as their departures and the curves do not cross each other.
    const ordered = [...list].sort((a, b) => a.y1 - b.y1 || a.from.localeCompare(b.from) || a.field.localeCompare(b.field));
    ordered.forEach((it, k) => {
      const y2 = dst.y + (dst.h * (k + 1)) / (ordered.length + 1);
      const x2 = dst.x;
      const bend = Math.max(34, (x2 - it.x1) / 2);
      edges.push({
        from: it.from,
        to: target,
        field: it.field,
        path: `M ${round(it.x1)} ${round(it.y1)} C ${round(it.x1 + bend)} ${round(it.y1)} ${round(x2 - bend)} ${round(y2)} ${round(x2)} ${round(y2)}`,
        // Placed at ~a third of the way along rather than the midpoint: source
        // anchors are already spread by edge index, so staying near them keeps
        // labels apart, while midpoints converge wherever several edges do.
        labelX: round(it.x1 + (x2 - it.x1) * 0.32),
        labelY: round(it.y1 + (y2 - it.y1) * 0.2 - 4),
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

  const width = MARGIN_X * 2 + columnCount * NODE_W + Math.max(0, columnCount - 1) * COL_GAP;
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
