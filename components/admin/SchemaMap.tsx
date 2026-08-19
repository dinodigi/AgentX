import Link from "next/link";
import type { MapMode, SchemaMapLayout, MapNode, Exposure } from "@/lib/schema-map";

/**
 * The schema map, rendered server-side as inline SVG — no client JS, no graph
 * library, no runtime layout. `lib/schema-map.ts` decides every coordinate; this
 * file only draws, which is why the layout is unit-testable on its own.
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

function FieldRows({ n }: { n: MapNode }) {
  return (
    <g fontSize="10" fill="var(--color-ink-mute)">
      {n.rows.map((f, i) => {
        const y = n.y + 24 + 11 + i * 15;
        const rel = f.type === "relation";
        return (
          <text key={f.name} x={n.x + 9} y={y}>
            <tspan fill={rel ? "var(--color-accent)" : "var(--color-ink-mute)"}>{f.name}</tspan>
            <tspan fill="var(--color-line-strong)">
              {"  "}
              {f.type}
              {f.unique ? " ◆" : ""}
              {f.indexed ? " ⌘" : ""}
              {f.searchable ? " ⌕" : ""}
            </tspan>
          </text>
        );
      })}
      {n.hiddenFields > 0 && (
        <text x={n.x + 9} y={n.y + 24 + 11 + n.rows.length * 15} fill="var(--color-line-strong)">
          + {n.hiddenFields} more
        </text>
      )}
    </g>
  );
}

export function SchemaMap({
  layout,
  mode,
  projectId,
  summary,
}: {
  layout: SchemaMapLayout;
  mode: MapMode;
  projectId: string;
  summary: string;
}) {
  const tab = (m: MapMode, label: string, hint: string) => {
    const active = m === mode;
    return (
      <Link
        href={`/admin/${projectId}/schema${m === "public" ? "?view=public" : ""}`}
        aria-current={active ? "page" : undefined}
        title={hint}
        className={`rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
          active
            ? "border border-line-strong bg-card text-ink"
            : "border border-transparent text-ink-mute hover:text-ink"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em] text-ink">Schema map</h1>
          <p className="m-0 font-mono text-[11.5px] text-ink-mute">{summary}</p>
        </div>
        <div className="flex gap-1 rounded-lg border border-line bg-paper p-1">
          {tab("model", "content model", "Every collection and field")}
          {tab("public", "public surface", "Only what the delivery API serves anonymously")}
        </div>
      </div>

      {mode === "public" && (
        <p className="m-0 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-mute">
          Exactly what an anonymous caller can read over the delivery API — nothing else is drawn.
          Containers are collapsed, so an exposed <code className="font-mono text-[12px]">group</code> or{" "}
          <code className="font-mono text-[12px]">array</code> shows as one field; inside a public container
          sub-fields are public by default and opt out with{" "}
          <code className="font-mono text-[12px]">publicRead:false</code>.
        </p>
      )}

      {layout.nodes.length === 0 ? (
        <div className="rounded-lg border border-line bg-card px-5 py-8 text-[13.5px] text-ink-mute">
          {mode === "public"
            ? "No collection exposes a publicly readable field, so the delivery API serves nothing anonymously. For an internal model that is the correct answer."
            : "No collections yet. Your agent defines them over MCP."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-card p-4">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width={layout.width}
            role="img"
            aria-label={`Schema map: ${summary}. ${layout.edges
              .map((e) => `${e.from}.${e.field} references ${e.to}`)
              .join("; ")}`}
            style={{ maxWidth: "100%", height: "auto" }}
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
            <g fill="none" stroke="var(--color-accent)" strokeWidth="1.3" markerEnd="url(#sm-arrow)">
              {layout.edges.map((e) => (
                <path key={`${e.from}.${e.field}->${e.to}`} d={e.path} />
              ))}
            </g>
            <g
              fontFamily="var(--font-mono)"
              fontSize="10"
              fill="var(--color-accent)"
              paintOrder="stroke"
              stroke="var(--color-card)"
              strokeWidth="3.5"
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
                    rx="4"
                    fill="var(--color-paper)"
                    stroke="var(--color-line-strong)"
                  />
                  <rect x={n.x} y={n.y} width={n.w} height="24" rx="4" fill="var(--color-raised)" />
                  <line x1={n.x} y1={n.y + 24} x2={n.x + n.w} y2={n.y + 24} stroke="var(--color-line)" />
                  {/* Exposure is encoded in FORM as well as color: a filled bar on
                      the header's left edge, so it survives a greyscale print and
                      does not rely on hue alone. */}
                  <rect x={n.x} y={n.y} width="3.5" height="24" fill={EXPOSURE_FILL[n.exposure]} />
                  <text x={n.x + 12} y={n.y + 16} fontSize="11.5" fontWeight="700" fill="var(--color-ink)">
                    {n.name}
                  </text>
                  {n.hasAccessRules && (
                    <text
                      x={n.x + n.w - 8}
                      y={n.y + 16}
                      fontSize="9"
                      textAnchor="end"
                      fill="var(--color-line-strong)"
                    >
                      access
                    </text>
                  )}
                  <FieldRows n={n} />
                </g>
              ))}
            </g>
          </svg>
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[10.5px] text-ink-mute">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: EXPOSURE_FILL.public }} />
          public read
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: EXPOSURE_FILL.intake }} />
          anonymous write
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: EXPOSURE_FILL.private }} />
          private
        </span>
        <span>&#9670; unique</span>
        <span>&#8984; indexed</span>
        <span>&#8981; searchable</span>
        <span>arrows point from a relation field to the collection it targets</span>
      </div>

      {layout.omitted.length > 0 && (
        <p className="m-0 max-w-[70ch] text-[13px] leading-relaxed text-ink-mute">
          <span className="text-ink">Not drawn in this view:</span> {layout.omitted.join(", ")} — no publicly
          readable field, so the delivery API never returns them.
        </p>
      )}

      {layout.cycles.length > 0 && (
        <p className="m-0 max-w-[70ch] text-[13px] leading-relaxed text-ink-mute">
          <span className="text-ink">Circular reference:</span> {layout.cycles.join(", ")}. The edges are real
          and drawn; the left-to-right ordering of one side of the cycle is arbitrary.
        </p>
      )}
    </div>
  );
}
