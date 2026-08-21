/**
 * Loading skeletons for the admin.
 *
 * WHY THESE EXIST. The App Router blocks navigation on a segment with no loading
 * boundary: you click, and the browser sits on the OLD page — no spinner, no
 * change — until the server component finishes its queries. There were none, so
 * every navigation looked like a dead click.
 *
 * TWO THINGS THE FIRST VERSION GOT WRONG, both worth recording:
 *
 *  1. STRUCTURE. Every workspace-level page (`/admin`, `/admin/console`,
 *     `/admin/workspace`) renders its OWN `<WorkspaceSidebar>` plus a
 *     `min-w-0 flex-1` content column. The skeleton rendered neither, so as a
 *     bare div inside AdminShell's `flex` row it collapsed to its content width
 *     and squeezed against the left edge — it looked like it was inside the
 *     sidebar. A loading state has to reproduce the LAYOUT it stands in for,
 *     not just the content.
 *
 *  2. FIDELITY. The first version drew detailed fake tables and card grids from
 *     imagination rather than from the pages, so they claimed a shape the real
 *     screen did not have. A wrong wireframe is worse than a vague one: it
 *     promises a layout and then rearranges. These are deliberately quiet —
 *     a title bar and soft regions — which stays true as pages change.
 *
 * `prefers-reduced-motion` drops the pulse and keeps the shapes.
 */

/** One shimmering block. Tailwind classes so callers stay declarative. */
export function Bar({ w = "w-32", h = "h-4", className = "" }: { w?: string; h?: string; className?: string }) {
  return <span aria-hidden className={`block rounded bg-raised motion-safe:animate-pulse ${w} ${h} ${className}`} />;
}

/** A soft filled region standing in for a content area of unknown shape. */
export function Region({ h = "h-64", className = "" }: { h?: string; className?: string }) {
  return (
    <div
      aria-hidden
      className={`rounded-xl border border-line bg-raised/50 motion-safe:animate-pulse ${h} ${className}`}
    />
  );
}

/** The title block every admin page opens with. */
export function HeaderSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="mb-5 flex flex-col gap-2">
      <Bar w={wide ? "w-56" : "w-40"} h="h-6" />
      <Bar w="w-44" h="h-3" />
    </div>
  );
}

/**
 * Stand-in for the left rail on workspace-level routes, which render it from the
 * PAGE rather than a layout — so during loading it is gone unless we redraw it.
 * Width follows the same cookie the real rail does, so nothing shifts on swap.
 */
export function RailPlaceholder({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      aria-hidden
      className={`hidden shrink-0 flex-col gap-1.5 border-r border-line bg-card px-2.5 py-4 md:sticky md:top-[52px] md:flex md:h-[calc(100vh-52px)] ${
        collapsed ? "md:w-[60px] md:items-center" : "md:w-64"
      }`}
    >
      {Array.from({ length: 7 }, (_, i) => (
        <Bar key={i} w={collapsed ? "w-5" : i === 0 ? "w-20" : "w-full"} h="h-7" className="rounded-lg opacity-60" />
      ))}
    </div>
  );
}

/**
 * The whole workspace-level shell: rail + content column, matching what
 * `/admin`, `/admin/console` and `/admin/workspace` each build themselves.
 */
export function WorkspaceShellSkeleton({
  collapsed,
  wide = false,
}: {
  collapsed: boolean;
  wide?: boolean;
}) {
  return (
    <>
      <RailPlaceholder collapsed={collapsed} />
      <div role="status" aria-label="Loading" className="min-w-0 flex-1">
        <span className="sr-only">Loading…</span>
        <div className="mx-auto max-w-[1200px] px-5 py-8 md:px-10 md:py-10">
          <HeaderSkeleton wide={wide} />
          <Region h="h-[420px]" />
        </div>
      </div>
    </>
  );
}

/**
 * Content-only skeleton for routes UNDER a project. The project layout already
 * supplies the rail, the `<main>` padding and the right-hand content sidebar,
 * so these must NOT redraw any of it — doing so is what broke the first version.
 */
export function ProjectPageSkeleton({ regionHeight = "h-[420px]" }: { regionHeight?: string }) {
  return (
    <div role="status" aria-label="Loading">
      <span className="sr-only">Loading…</span>
      <HeaderSkeleton />
      <Region h={regionHeight} />
    </div>
  );
}
