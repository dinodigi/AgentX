import Link from "next/link";
import type { MapMode, MapDensity, SchemaMapLayout, Exposure } from "@/lib/schema-map";
import { SchemaCanvas } from "./SchemaCanvas";

/**
 * The schema map, rendered server-side as inline SVG — no client JS, no graph
 * library, no runtime layout. `lib/schema-map.ts` decides every coordinate; this
 * file only draws, which is why the layout is unit-testable on its own.
 *
 * This is the CHROME: header, switches, legend, and the empty states. The
 * drawing itself lives in SchemaCanvas, a client component, because pan/zoom/drag
 * and a detail panel need state. The split keeps the server doing the layout —
 * deterministic and unit-tested — and the client only moving things afterwards.
 *
 * The mode and density switches are LINKS, not toggles, so each view stays a
 * server render and a shareable URL — useful when the public-surface view is the
 * thing you want to send someone.
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
        <SchemaCanvas
          initialNodes={layout.nodes}
          specs={layout.specs}
          width={layout.width}
          height={layout.height}
          density={density}
          storageKey={`pluggie:schema-map:${projectId}:${mode}:${density}`}
        />
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
