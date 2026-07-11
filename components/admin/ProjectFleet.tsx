import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { ago, BrandTile, ConnectorHealth, Dot, isActive, Metric, sinceMonth } from "./fleet-util";

/**
 * The studio home as a fleet control plane. Each project is a live client
 * backend; the operator scans identity, scale, connector health and last-write
 * pulse across all of them. Opens in the platform's own transcript voice.
 */
export interface FleetProject {
  id: string;
  name: string;
  initial: string;
  logoUrl?: string | null;
  brand: string;
  brandInk: string;
  collections: number;
  entries: number;
  connectors: { type: string; status: string }[];
  lastActivity: string | null;
  createdAt: string;
}

export function ProjectFleet({
  owned,
  shared = [],
  canCreate = false,
}: {
  /** Projects reached via workspace membership (the viewer's own). */
  owned: FleetProject[];
  /** Projects reached only via a per-project share (an outsider handoff). */
  shared?: FleetProject[];
  /** LAUNCH-PLAN 0.1: creation is operator-only until B2 reopens it. */
  canCreate?: boolean;
}) {
  const projects = [...owned, ...shared];
  const totalCollections = projects.reduce((s, p) => s + p.collections, 0);
  const totalEntries = projects.reduce((s, p) => s + p.entries, 0);
  // Fleet is "green" when no connected project has a connector in error.
  const anyError = projects.some((p) => p.connectors.some((c) => c.status === "error"));
  // Only label the groups when there's something in both — otherwise the page
  // heading already says "Projects" and a lone label is noise.
  const labelGroups = owned.length > 0 && shared.length > 0;

  return (
    <div className="mx-auto max-w-[1200px] px-5 py-8 md:px-10 md:py-10">
      {/* Signature: the platform reports its own state, in its own voice. */}
      <div
        className="mb-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-line bg-card px-5 py-4"
      >
        <p className="m-0 font-mono text-[12.5px] leading-relaxed">
          <span className="text-line-strong">agentx ◂ </span>
          <span className="text-ink">{projects.length}</span>
          <span className="text-ink-mute">
            {" "}
            {projects.length === 1 ? "project" : "projects"} ·{" "}
          </span>
          <span className="text-ink">{totalCollections}</span>
          <span className="text-ink-mute"> collections · </span>
          <span className="text-ink">{totalEntries}</span>
          <span className="text-ink-mute"> entries</span>
        </p>
        <span
          className="inline-flex items-center gap-2 font-mono text-[11px]"
          style={{ color: anyError ? "var(--color-warn)" : "var(--color-accent)" }}
        >
          <Dot status={anyError ? "error" : "live"} live={!anyError} />
          {anyError ? "attention needed" : "all systems live"}
        </span>
      </div>

      <div className="mb-4 flex items-end justify-between">
        <div>
          <p className="eyebrow mb-1">Studio</p>
          <h1 className="display text-[22px] font-semibold leading-none">Projects</h1>
        </div>
        {canCreate && (
          <Link href="/admin/new" className="btn btn-primary">
            <Plus className="h-4 w-4" />
            New project
          </Link>
        )}
      </div>

      {projects.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-14 text-center">
          <p className="display text-lg font-semibold">
            {canCreate ? "No backends yet" : "No projects yet"}
          </p>
          <p className="max-w-sm text-sm text-ink-mute">
            {canCreate
              ? "A project gives you a branded admin, an MCP endpoint, and a delivery API — defined by an agent, handed to a client."
              : "Projects shared with you appear here. During the beta we onboard new projects by hand — request a spot and we'll set yours up with you."}
          </p>
          {canCreate ? (
            <Link href="/admin/new" className="btn btn-ink mt-1">
              <Plus className="h-4 w-4" />
              New project
            </Link>
          ) : (
            <Link href="/pricing" className="btn btn-ink mt-1">
              Request beta access
            </Link>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-7">
          {owned.length > 0 && (
            <section>
              {labelGroups && <GroupLabel>Your projects</GroupLabel>}
              <ul className="flex flex-col gap-2.5">
                {owned.map((p) => (
                  <ProjectRow key={p.id} p={p} />
                ))}
              </ul>
            </section>
          )}
          {shared.length > 0 && (
            <section>
              <GroupLabel>Shared with you</GroupLabel>
              <ul className="flex flex-col gap-2.5">
                {shared.map((p) => (
                  <ProjectRow key={p.id} p={p} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-2.5">{children}</p>;
}

function ProjectRow({ p }: { p: FleetProject }) {
  return (
    <li>
      <Link
        href={`/admin/${p.id}`}
        className="group relative flex items-center gap-4 overflow-hidden rounded-xl border border-line bg-card p-4 transition-colors hover:border-line-strong"
      >
        {/* brand-tinted left edge on hover — identity, not decoration */}
        <span
          className="absolute inset-y-0 left-0 w-[3px] opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: p.brand }}
        />
        <BrandTile brand={p.brand} brandInk={p.brandInk} initial={p.initial} logoUrl={p.logoUrl} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="display truncate text-[15px] font-semibold text-ink">{p.name}</span>
            {isActive(p.lastActivity) && <Dot status="live" live />}
          </div>
          <div className="truncate font-mono text-[11px] text-line-strong">
            prj_{p.id.slice(0, 8)} · since {sinceMonth(p.createdAt)}
          </div>
          {/* compact meta for small screens */}
          <div className="mt-2 flex items-center gap-3 md:hidden">
            <span className="font-mono text-[11px] text-ink-mute">
              {p.collections} coll · {p.entries} entries
            </span>
            <ConnectorHealth connectors={p.connectors} />
          </div>
        </div>

        <div className="hidden items-center gap-7 md:flex">
          <Metric value={p.collections} label="collections" />
          <Metric value={p.entries} label="entries" />
          <span className="h-9 w-px bg-line" />
          <ConnectorHealth connectors={p.connectors} />
          <div className="flex min-w-[86px] flex-col items-end gap-0.5">
            <span className="font-mono text-[11px] text-ink-mute">{ago(p.lastActivity)}</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-line-strong">
              last write
            </span>
          </div>
        </div>

        <ChevronRight className="h-4 w-4 shrink-0 text-line-strong transition-transform group-hover:translate-x-0.5 group-hover:text-ink-mute" />
      </Link>
    </li>
  );
}
