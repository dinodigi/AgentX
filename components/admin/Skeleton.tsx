/**
 * Loading skeletons for the admin.
 *
 * WHY THESE EXIST. The App Router blocks navigation on a segment that has no
 * loading boundary: you click, and the browser sits on the OLD page — no
 * spinner, no change, nothing — until the server component finishes its
 * queries. Operator report: "some of the buttons are buggy, and they take a
 * little bit of time when you click." The buttons were fine. There was simply
 * no feedback that the click had registered, and the fleet dashboard was
 * fanning out to eighteen tenant databases behind it.
 *
 * A skeleton is not decoration here — it is the only thing that tells a person
 * their click did something. Shapes deliberately echo the real layout so the
 * page does not visibly jump when it swaps in.
 *
 * `prefers-reduced-motion` drops the pulse and leaves the shapes, so the
 * feedback survives without the movement.
 */

/** One shimmering block. `w`/`h` are Tailwind classes so callers stay declarative. */
export function Bar({ w = "w-32", h = "h-4", className = "" }: { w?: string; h?: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={`block rounded bg-raised motion-safe:animate-pulse ${w} ${h} ${className}`}
    />
  );
}

/** The heading block every admin page opens with. */
export function HeaderSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="mb-5 flex flex-col gap-2">
      <Bar w={wide ? "w-64" : "w-40"} h="h-6" />
      <Bar w="w-56" h="h-3" />
    </div>
  );
}

/** A grid of cards — the fleet dashboard and the plugin/console lists. */
export function CardGridSkeleton({ n = 6 }: { n?: number }) {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="card flex flex-col gap-3 p-4">
          <div className="flex items-center gap-2.5">
            <Bar w="w-8" h="h-8" className="rounded-lg" />
            <Bar w="w-28" h="h-4" />
          </div>
          <Bar w="w-full" h="h-3" />
          <Bar w="w-2/3" h="h-3" />
        </div>
      ))}
    </div>
  );
}

/** A bordered table — entries, trash, assets, the feedback wall. */
export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="flex items-center gap-4 border-b border-line bg-raised px-4 py-2.5">
        <Bar w="w-24" h="h-3" />
        <Bar w="w-16" h="h-3" />
        <Bar w="w-20" h="h-3" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-b-0">
          <Bar w="w-40" h="h-3.5" />
          <Bar w="w-16" h="h-3" />
          <Bar w="w-24" h="h-3" />
        </div>
      ))}
    </div>
  );
}

/** Stacked panels — settings, connectors, appearance. */
export function PanelsSkeleton({ n = 3 }: { n?: number }) {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="card flex flex-col gap-3 p-5">
          <Bar w="w-36" h="h-4" />
          <Bar w="w-full" h="h-3" />
          <Bar w="w-3/4" h="h-3" />
          <Bar w="w-28" h="h-8" className="mt-1 rounded-md" />
        </div>
      ))}
    </div>
  );
}

/** Wrapper matching the admin's page padding, so nothing shifts on swap. */
export function PageSkeleton({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" aria-label="Loading" className="animate-none">
      <span className="sr-only">Loading…</span>
      {children}
    </div>
  );
}
