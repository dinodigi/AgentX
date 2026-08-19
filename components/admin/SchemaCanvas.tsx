"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildEdgePaths, type MapNode, type EdgeSpec, type MapDensity, type Exposure } from "@/lib/schema-map";

/**
 * The interactive half of the schema map: pan, zoom, drag a collection, click one
 * to inspect it.
 *
 * The server still computes the INITIAL layout — deterministic, tested, and the
 * thing you get back when you hit Reset. This component only moves nodes around
 * afterwards, and re-routes edges through the SAME `buildEdgePaths` the server
 * used, so a dragged layout cannot drift from a fresh one.
 *
 * Positions persist per project + view in localStorage. An operator who spends a
 * minute arranging 25 collections should not lose it on navigate, and the arrangement
 * is a personal preference rather than project data, so the browser is the right
 * home for it — no schema change, nothing to sync, nothing to migrate.
 */

const EXPOSURE_FILL: Record<Exposure, string> = {
  public: "var(--color-warn)",
  intake: "var(--color-accent)",
  private: "var(--color-line-strong)",
};
const EXPOSURE_LABEL: Record<Exposure, string> = {
  public: "public read",
  intake: "anonymous write",
  private: "private",
};

const MIN_K = 0.25;
const MAX_K = 2.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Props {
  initialNodes: MapNode[];
  specs: EdgeSpec[];
  width: number;
  height: number;
  density: MapDensity;
  storageKey: string;
}

export function SchemaCanvas({ initialNodes, specs, width, height, density, storageKey }: Props) {
  const [nodes, setNodes] = useState<MapNode[]>(initialNodes);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const [moved, setMoved] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Set while dragging so a drag never registers as a click on the node. */
  const dragged = useRef(false);

  // A fresh server layout replaces local state when the view changes (mode or
  // density), otherwise switching to `public` would keep stale positions for a
  // different set of collections.
  useEffect(() => setNodes(initialNodes), [initialNodes]);

  // ---------------------------------------------------------------- persistence
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, { x: number; y: number }>;
      setNodes((cur) => cur.map((n) => (saved[n.name] ? { ...n, ...saved[n.name] } : n)));
      setMoved(true);
    } catch {
      // A corrupt or unavailable store must never stop the map rendering.
    }
  }, [storageKey]);

  const persist = useCallback(
    (next: MapNode[]) => {
      try {
        const pos: Record<string, { x: number; y: number }> = {};
        for (const n of next) pos[n.name] = { x: n.x, y: n.y };
        window.localStorage.setItem(storageKey, JSON.stringify(pos));
      } catch {
        /* private mode, quota — not worth surfacing */
      }
    },
    [storageKey],
  );

  // ---------------------------------------------------------------- geometry
  // Edges follow the nodes, always through the server's own routing function.
  const edges = useMemo(() => buildEdgePaths(nodes, specs), [nodes, specs]);

  // The drawing can grow past the server's estimate once nodes are dragged.
  const extent = useMemo(() => {
    let w = width;
    let h = height;
    for (const n of nodes) {
      w = Math.max(w, n.x + n.w + 40);
      h = Math.max(h, n.y + n.h + 40);
    }
    return { w, h };
  }, [nodes, width, height]);

  // ---------------------------------------------------------------- interaction
  const zoomBy = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      if (cx === undefined || cy === undefined) return { ...v, k };
      // Keep the point under the cursor fixed while scaling.
      const ratio = k / v.k;
      return { k, tx: cx - (cx - v.tx) * ratio, ty: cy - (cy - v.ty) * ratio };
    });
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel keeps scrolling the page
      e.preventDefault();
      const box = wrapRef.current?.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - (box?.left ?? 0), e.clientY - (box?.top ?? 0));
    },
    [zoomBy],
  );

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const from = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    const move = (ev: PointerEvent) =>
      setView((v) => ({ ...v, tx: from.tx + (ev.clientX - from.x), ty: from.ty + (ev.clientY - from.y) }));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const startDrag = (e: React.PointerEvent, name: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const el = e.currentTarget as unknown as SVGGElement;
    el.setPointerCapture(e.pointerId);
    dragged.current = false;
    const start = { x: e.clientX, y: e.clientY };
    const origin = nodes.find((n) => n.name === name);
    if (!origin) return;
    const base = { x: origin.x, y: origin.y };

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / view.k;
      const dy = (ev.clientY - start.y) / view.k;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragged.current = true;
      setNodes((cur) => cur.map((n) => (n.name === name ? { ...n, x: base.x + dx, y: base.y + dy } : n)));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      if (dragged.current) {
        setMoved(true);
        setNodes((cur) => {
          persist(cur);
          return cur;
        });
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const fit = useCallback(() => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    const k = clamp(Math.min(box.width / extent.w, box.height / extent.h) * 0.96, MIN_K, MAX_K);
    setView({ k, tx: (box.width - extent.w * k) / 2, ty: (box.height - extent.h * k) / 2 });
  }, [extent]);

  const reset = () => {
    setNodes(initialNodes);
    setMoved(false);
    setSelected(null);
    setView({ k: 1, tx: 0, ty: 0 });
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  };

  const node = selected ? nodes.find((n) => n.name === selected) : null;
  const relatedOut = node ? specs.filter((s) => s.from === node.name) : [];
  const relatedIn = node ? specs.filter((s) => s.to === node.name) : [];

  const btn =
    "rounded-md border border-line bg-card px-2 py-1 font-mono text-[11px] text-ink-mute transition-colors hover:text-ink disabled:opacity-40";

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {/* ---- controls ---- */}
      <div className="absolute left-4 top-4 z-10 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => zoomBy(1 / 1.2)} className={btn} title="Zoom out" aria-label="Zoom out">
          &minus;
        </button>
        <span className="min-w-[3.2rem] rounded-md border border-line bg-card px-2 py-1 text-center font-mono text-[11px] text-ink-mute tabular-nums">
          {Math.round(view.k * 100)}%
        </span>
        <button type="button" onClick={() => zoomBy(1.2)} className={btn} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={fit} className={btn} title="Fit the whole map in view">
          fit
        </button>
        <button type="button" onClick={reset} className={btn} disabled={!moved} title="Return to the generated layout">
          reset layout
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-3 left-4 z-10 m-0 font-mono text-[10.5px] text-line-strong">
        drag a collection to move it · drag the background to pan · ⌘/ctrl + scroll to zoom
      </p>

      {/* ---- canvas ---- */}
      <div
        ref={wrapRef}
        onPointerDown={startPan}
        onWheel={onWheel}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        style={{
          backgroundImage: "radial-gradient(circle, var(--color-line) 1px, transparent 1px)",
          backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
          backgroundPosition: `${view.tx}px ${view.ty}px`,
        }}
      >
        <svg width="100%" height="100%" role="img" aria-label={`Schema map, ${nodes.length} collections`}>
          <defs>
            <marker
              id="sc-arrow"
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
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
            <g fill="none" stroke="var(--color-accent)" strokeWidth="1.25" markerEnd="url(#sc-arrow)">
              {edges.map((e) => {
                const dim = selected !== null && e.from !== selected && e.to !== selected;
                return (
                  <path
                    key={`${e.from}.${e.field}->${e.to}`}
                    d={e.path}
                    opacity={dim ? 0.16 : 0.8}
                    strokeWidth={selected !== null && !dim ? 1.9 : 1.25}
                  />
                );
              })}
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
              {edges.map((e) => {
                const dim = selected !== null && e.from !== selected && e.to !== selected;
                return (
                  <text
                    key={`l-${e.from}.${e.field}->${e.to}`}
                    x={e.labelX}
                    y={e.labelY}
                    textAnchor="middle"
                    opacity={dim ? 0.14 : 1}
                  >
                    {e.field}
                  </text>
                );
              })}
            </g>

            <g fontFamily="var(--font-mono)">
              {nodes.map((n) => {
                const isSel = n.name === selected;
                const linked =
                  selected !== null &&
                  (isSel || specs.some((s) => (s.from === selected && s.to === n.name) || (s.to === selected && s.from === n.name)));
                return (
                  <g
                    key={n.name}
                    onPointerDown={(e) => startDrag(e, n.name)}
                    onClick={() => {
                      if (!dragged.current) setSelected(isSel ? null : n.name);
                    }}
                    style={{ cursor: "grab" }}
                    opacity={selected !== null && !linked ? 0.4 : 1}
                  >
                    <title>{`${n.name} — ${EXPOSURE_LABEL[n.exposure]}${n.hasAccessRules ? ", access rules applied" : ""}`}</title>
                    <rect
                      x={n.x}
                      y={n.y}
                      width={n.w}
                      height={n.h}
                      rx="5"
                      fill="var(--color-card)"
                      stroke={isSel ? "var(--brand)" : "var(--color-line-strong)"}
                      strokeWidth={isSel ? 2 : 1}
                    />
                    <rect x={n.x} y={n.y} width={n.w} height="24" rx="5" fill="var(--color-raised)" />
                    <line x1={n.x} y1={n.y + 24} x2={n.x + n.w} y2={n.y + 24} stroke="var(--color-line)" />
                    <rect x={n.x} y={n.y} width="3.5" height="24" fill={EXPOSURE_FILL[n.exposure]} />
                    <text x={n.x + 13} y={n.y + 16} fontSize="11.5" fontWeight="700" fill="var(--color-ink)">
                      {n.name}
                    </text>
                    {n.hasAccessRules && (
                      <text x={n.x + n.w - 9} y={n.y + 16} fontSize="9" textAnchor="end" fill="var(--color-line-strong)">
                        access
                      </text>
                    )}
                    <g fontSize="10.5">
                      {n.rows.map((f, i) => (
                        <text key={f.name} x={n.x + 10} y={n.y + 35 + i * 15}>
                          <tspan fill={f.type === "relation" ? "var(--color-accent)" : "var(--color-ink)"}>{f.name}</tspan>
                          <tspan fill="var(--color-ink-mute)">
                            {"  "}
                            {f.type}
                            {f.unique ? " ◆" : ""}
                            {f.indexed ? " ⌘" : ""}
                            {f.searchable ? " ⌕" : ""}
                          </tspan>
                        </text>
                      ))}
                      {n.hiddenFields > 0 && (
                        <text x={n.x + 10} y={n.y + 35 + n.rows.length * 15} fill="var(--color-line-strong)">
                          {density === "compact" ? `${n.totalFields} fields` : `+ ${n.hiddenFields} more`}
                        </text>
                      )}
                    </g>
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
      </div>

      {/* ---- detail panel ---- */}
      {node && (
        <aside className="absolute right-0 top-0 z-20 flex h-full w-[320px] flex-col border-l border-line bg-card shadow-xl">
          <div className="flex shrink-0 items-start justify-between gap-2 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <p className="m-0 truncate font-mono text-[13px] font-semibold text-ink">{node.name}</p>
              <p className="m-0 mt-0.5 font-mono text-[10.5px] text-ink-mute">
                {node.totalFields} fields · {EXPOSURE_LABEL[node.exposure]}
                {node.hasAccessRules ? " · access rules" : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[13px] text-ink-mute hover:text-ink"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <p className="m-0 mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-line-strong">Fields</p>
            <ul className="m-0 list-none space-y-1 p-0">
              {node.allFields.map((f) => (
                <li key={f.name} className="flex items-baseline justify-between gap-2 font-mono text-[11.5px]">
                  <span className={f.type === "relation" ? "truncate text-brand" : "truncate text-ink"}>{f.name}</span>
                  <span className="shrink-0 text-ink-mute">
                    {f.type}
                    {f.type === "relation" && f.targetCollection ? `→${f.targetCollection}` : ""}
                    {f.publicRead ? " · public" : ""}
                    {f.unique ? " ◆" : ""}
                    {f.indexed ? " ⌘" : ""}
                    {f.searchable ? " ⌕" : ""}
                  </span>
                </li>
              ))}
            </ul>

            {relatedOut.length > 0 && (
              <>
                <p className="m-0 mb-1.5 mt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-line-strong">
                  References
                </p>
                <ul className="m-0 list-none space-y-1 p-0">
                  {relatedOut.map((s) => (
                    <li key={`${s.field}->${s.to}`} className="font-mono text-[11.5px] text-ink-mute">
                      <button type="button" onClick={() => setSelected(s.to)} className="text-brand hover:underline">
                        {s.to}
                      </button>{" "}
                      via {s.field}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {relatedIn.length > 0 && (
              <>
                <p className="m-0 mb-1.5 mt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-line-strong">
                  Referenced by
                </p>
                <ul className="m-0 list-none space-y-1 p-0">
                  {relatedIn.map((s) => (
                    <li key={`${s.from}.${s.field}`} className="font-mono text-[11.5px] text-ink-mute">
                      <button type="button" onClick={() => setSelected(s.from)} className="text-brand hover:underline">
                        {s.from}
                      </button>{" "}
                      via {s.field}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {relatedOut.length === 0 && relatedIn.length === 0 && (
              <p className="m-0 mt-4 text-[12px] leading-relaxed text-ink-mute">
                No relations — this collection stands alone in the model.
              </p>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
