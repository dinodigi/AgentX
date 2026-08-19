import Link from "next/link";
import type { MapMode, MapDensity, SchemaMapLayout, MapNode, Exposure } from "@/lib/schema-map";

/**
 * The schema map, rendered server-side as inline SVG — no client JS, no graph
 * library, no runtime layout. `lib/schema-map.ts` decides every coordinate; this
 * file only draws, which is why the layout is unit-testable on its own.
 *
 * IT IS A CANVAS, NOT A FIGURE. The first version put the SVG in a card inside
 * the page flow with `max-width: 100%`, which scaled a 2240px map down to the
 * column width — every label shrank to unreadable and the whole thing looked
 * cramped inside a lot of empty page. So the map now renders at its NATURAL size
 * inside a scrollable region that fills the viewport, the way a diagram tool
 * behaves: you pan it rather than squint at it.
 *
 * The mode switch is a LINK, not a toggle, so the whole view stays a server
 * render and each mode is a shareable URL — useful when the public-surface view
 * is the thing you want to send someone.
 */

const EXPOSURE_LABEL: Record<Exposure, string> = {
  public: "public read",
  intake: "anonymous write",
  private: "private",
};

/** Fills come from the admin's own tokens, so the map follows the theme. */
const EXPOSURE_FILL: Record<Exposure, string> = {
  public: "var(--color-warn)",
  intake: "var(--color-accent)",
  private: "var(--color-line-strong)",
};

function FieldRows({ n, density }: { n: MapNode; density: MapDensity }) {
  return (
    <g fontSize="10.5">
      {n.rows.map((f, i) => {
        const y = n.y + 24 + 11 + i * 15;
        const rel = f.type === "relation";
        const marks =
          (f.unique ? " ◆" : "") + (f.indexed ? " ⌘" : "") + (f.searchable ? " ⌕" : "");
        return (
          <text key={f.name} x={n.x + 10} y={y}>
            {/* Name at full ink, type muted — the first version had both at low
                contrast, which read as grey mush at a glance. */}
            <tspan fill={rel ? "var(--color-accent)" : "var(--color-ink)"}>{f.name}</tspan>
            <tspan fill="var(--color-ink-mute)">
              {"  "}
              {f.type}
              {marks}
            </tspan>
          </text>
        );
      })}
      {n.hiddenFields > 0 && (
        <text x={n.x + 10} y={n.y + 24 + 11 + n.rows.length * 15} fill="var(--color-line-strong)">
          {/* Compact states the collection's real size rather than a remainder —
              "12 fields" is information; "+ 12 more" only makes sense when some
              were listed. */}
          {density === "compact" ? `${n.totalFields} fields` : `+ ${n.hiddenFields} more`}
        </text>
      )}
    </g>
  );
}

export function SchemaMap({
  layout,
  mode,
  density,
  projectId,
  summary,
}: {
  layout: SchemaMapLayout;
  mode: MapMode;
  density: MapDensity;
  projectId: string;
  summary: string;
}) {
  const href = (m: MapMode, d: MapDensity) => {
    const q = [m === "public" ? "view=public" : "", d === "detailed" ? "density=detailed" : ""].filter(Boolean);
    return `/admin/${projectId}/schema${q.length ? `?${q.join("&")}` : ""}`;
  };
  const pill = (active: boolean, to: string, label: string, hint: string) => (
    <Link
      href={to}
      aria-current={active ? "page" : undefined}
      title={hint}
      className={`rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
        active ? "border border-line-strong bg-card text-ink" : "border border-transparent text-ink-mute hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );

  const tab = (m: MapMode, label: string, hint: string) => {
    const active = m === mode;
    return (
      <Link
        href={href(m, density)}
        aria-current={active ? "page" : undefined}
        title={hint}
        className={`rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
          active ? "border border-line-strong bg-card text-ink" : "border border-transparent text-ink-mute hover:text-ink"
        }`}
      >
        {label}
      </Link>
    );
  };

  const legend = (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-[10.5px] text-ink-mute">
      {(["public", "intake", "private"] as Exposure[]).map((e) => (
        <span key={e} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: EXPOSURE_FILL[e] }} />
          {EXPOSURE_LABEL[e]}
        </span>
      ))}
      <span>&#9670; unique</span>
      <span>&#8984; indexed</span>
      <span>&#8981; searchable</span>
      <span className="text-line-strong">arrows point from a relation field to the collection it targets</span>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---- header: title, summary, mode switch ---- */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="m-0 text-[19px] font-semibold tracking-[-0.02em] text-ink">Schema map</h1>
          <p className="m-0 font-mono text-[11.5px] text-ink-mute">{summary}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg border border-line bg-paper p-1">
            {tab("model", "content model", "Every collection")}
            {tab("public", "public surface", "Only what the delivery API serves anonymously")}
          </div>
          <div className="flex gap-1 rounded-lg border border-line bg-paper p-1">
            {pill(density === "compact", href(mode, "compact"), "compact", "Relations plus a field count — structure at a glance")}
            {pill(density === "detailed", href(mode, "detailed"), "fields", "List each collection's fields")}
          </div>
        </div>
      </div>

      {mode === "public" && (
        <p className="m-0 shrink-0 border-b border-line px-6 py-2.5 text-[12.5px] leading-relaxed text-ink-mute">
          Exactly what an anonymous caller can read over the delivery API — nothing else is drawn. Containers are
          collapsed, so an exposed <span className="font-mono">group</span> or{" "}
          <span className="font-mono">array</span> shows as one field; inside a public container sub-fields are
          public by default and opt out with <span className="font-mono">publicRead:false</span>.
        </p>
      )}

      {/* ---- the canvas ---- */}
      {layout.nodes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="m-0 max-w-[52ch] text-center text-[13.5px] leading-relaxed text-ink-mute">
            {mode === "public"
              ? "No collection exposes a publicly readable field, so the delivery API serves nothing anonymously. For an internal model that is the correct answer."
              : "No collections yet. Your agent defines them over MCP."}
          </p>
        </div>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto"
          style={{
            // A faint dot grid: reads as a canvas surface rather than a page, and
            // gives the eye a fixed reference while panning.
            backgroundImage: "radial-gradient(circle, var(--color-line) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
            backgroundPosition: "-1px -1px",
          }}
        >
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width={layout.width}
            height={layout.height}
            role="img"
            aria-label={`Schema map: ${summary}. ${layout.edges
              .map((e) => `${e.from}.${e.field} references ${e.to}`)
              .join("; ")}`}
            className="block"
          >
            <defs>
              <marker
                id="sm-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--color-accent)" />
              </marker>
            </defs>

            {/* Edges first — nodes are opaque and paint over any crossing. */}
            <g fill="none" stroke="var(--color-accent)" strokeWidth="1.25" opacity="0.75" markerEnd="url(#sm-arrow)">
              {layout.edges.map((e) => (
                <path key={`${e.from}.${e.field}->${e.to}`} d={e.path} />
              ))}
            </g>
            <g
              fontFamily="var(--font-mono)"
              fontSize="10"
              fill="var(--color-accent)"
              paintOrder="stroke"
              stroke="var(--color-paper)"
              strokeWidth="4"
              strokeLinejoin="round"
            >
              {layout.edges.map((e) => (
                <text key={`l-${e.from}.${e.field}->${e.to}`} x={e.labelX} y={e.labelY} textAnchor="middle">
                  {e.field}
                </text>
              ))}
            </g>

            <g fontFamily="var(--font-mono)">
              {layout.nodes.map((n) => (
                <g key={n.name}>
                  <title>
                    {n.name} — {EXPOSURE_LABEL[n.exposure]}
                    {n.hasAccessRules ? ", access rules applied" : ""}
                  </title>
                  <rect
                    x={n.x}
                    y={n.y}
                    width={n.w}
                    height={n.h}
                    rx="5"
                    fill="var(--color-card)"
                    stroke="var(--color-line-strong)"
                  />
                  <rect x={n.x} y={n.y} width={n.w} height="24" rx="5" fill="var(--color-raised)" />
                  <line x1={n.x} y1={n.y + 24} x2={n.x + n.w} y2={n.y + 24} stroke="var(--color-line)" />
                  {/* Exposure is encoded in FORM as well as color: a filled bar on
                      the header's left edge, so it survives a greyscale print and
                      does not rely on hue alone. */}
                  <rect x={n.x} y={n.y} width="3.5" height="24" fill={EXPOSURE_FILL[n.exposure]} />
                  <text x={n.x + 13} y={n.y + 16} fontSize="11.5" fontWeight="700" fill="var(--color-ink)">
                    {n.name}
                  </text>
                  {n.hasAccessRules && (
                    <text x={n.x + n.w - 9} y={n.y + 16} fontSize="9" textAnchor="end" fill="var(--color-line-strong)">
                      access
                    </text>
                  )}
                  <FieldRows n={n} density={density} />
                </g>
              ))}
            </g>
          </svg>
        </div>
      )}

      {/* ---- footer: legend + the two things the layout has to admit ---- */}
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-line px-6 py-3">
        {legend}
        {layout.omitted.length > 0 && (
          <p className="m-0 text-[12px] leading-relaxed text-ink-mute">
            <span className="text-ink">Not drawn:</span> {layout.omitted.join(", ")} — no publicly readable field,
            so the delivery API never returns them.
          </p>
        )}
        {layout.cycles.length > 0 && (
          <p className="m-0 text-[12px] leading-relaxed text-ink-mute">
            <span className="text-ink">Circular reference:</span> {layout.cycles.join(", ")}. The edges are real
            and drawn; the left-to-right ordering of one side of the cycle is arbitrary.
          </p>
        )}
      </div>
    </div>
  );
}
