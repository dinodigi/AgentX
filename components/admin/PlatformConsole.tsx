import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { ago, BrandTile, ConnectorHealth, Dot, Metric, sinceMonth } from "./fleet-util";
import type { PlatformProject, PlatformWorkspace } from "@/lib/platform";

/**
 * The operator console (B4): every workspace and every project on the platform,
 * in one operator-only surface. Distinct from the studio fleet (which is now
 * per-operator) — this is the god view: cross-tenant scale, connector health,
 * and a link into any project for support.
 */
export function PlatformConsole({
  workspaces,
  projects,
}: {
  workspaces: PlatformWorkspace[];
  projects: PlatformProject[];
}) {
  const totalEntries = projects.reduce((s, p) => s + p.entries, 0);
  const totalCollections = projects.reduce((s, p) => s + p.collections, 0);
  const anyError = projects.some((p) => p.connectors.some((c) => c.status === "error"));

  return (
    <div className="mx-auto max-w-[1200px] px-5 py-8 md:px-10 md:py-10">
      {/* Operator transcript header — the platform reporting on itself. */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border border-line bg-card px-5 py-4">
        <p className="m-0 font-mono text-[12.5px] leading-relaxed">
          <span className="text-line-strong">platform ◂ </span>
          <span className="text-ink">{workspaces.length}</span>
          <span className="text-ink-mute"> {workspaces.length === 1 ? "workspace" : "workspaces"} · </span>
          <span className="text-ink">{projects.length}</span>
          <span className="text-ink-mute"> {projects.length === 1 ? "project" : "projects"} · </span>
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
          {anyError ? "connector attention" : "all systems live"}
        </span>
      </div>

      <div className="mb-4">
        <p className="eyebrow mb-1">Operator console</p>
        <h1 className="display text-[22px] font-semibold leading-none">Platform</h1>
        <p className="mt-2 max-w-xl text-sm text-ink-mute">
          Every tenant on the platform. Plan and usage-cap columns land with billing (B3); a suspend control
          follows. Opening a project here is support access — treat it accordingly.
        </p>
      </div>

      {/* WORKSPACES */}
      <section className="mb-9">
        <p className="eyebrow mb-2.5">Workspaces</p>
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-card text-left font-mono text-[10.5px] uppercase tracking-[0.12em] text-line-strong">
                <th className="px-4 py-2.5 font-medium">Workspace</th>
                <th className="px-4 py-2.5 text-right font-medium">Members</th>
                <th className="px-4 py-2.5 text-right font-medium">Projects</th>
                <th className="hidden px-4 py-2.5 text-right font-medium md:table-cell">Since</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((w) => (
                <tr key={w.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 font-medium text-ink">{w.name}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-ink-mute">{w.members}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-ink-mute">{w.projects}</td>
                  <td className="hidden px-4 py-2.5 text-right font-mono text-[11px] text-line-strong md:table-cell">
                    {sinceMonth(w.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* PROJECTS — the full fleet */}
      <section>
        <p className="eyebrow mb-2.5">All projects</p>
        <ul className="flex flex-col gap-2.5">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/admin/${p.id}`}
                className="group relative flex items-center gap-4 overflow-hidden rounded-xl border border-line bg-card p-4 transition-colors hover:border-line-strong"
              >
                <span
                  className="absolute inset-y-0 left-0 w-[3px] opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ background: p.brand }}
                />
                <BrandTile brand={p.brand} brandInk={p.brandInk} initial={p.initial} logoUrl={p.logoUrl} />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="display truncate text-[15px] font-semibold text-ink">{p.name}</span>
                  </div>
                  <div className="truncate font-mono text-[11px] text-line-strong">
                    {p.workspaceName} · prj_{p.id.slice(0, 8)}
                    {p.plan && (
                      <>
                        {" · "}
                        <span className="text-ink-soft">{p.plan}</span>
                        {p.billing && p.billing !== "active" && (
                          <span style={{ color: p.billing === "exempt" ? undefined : "var(--color-warn)" }}>
                            {" "}({p.billing})
                          </span>
                        )}
                      </>
                    )}
                  </div>
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
                    <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-line-strong">last write</span>
                  </div>
                </div>

                <ChevronRight className="h-4 w-4 shrink-0 text-line-strong transition-transform group-hover:translate-x-0.5 group-hover:text-ink-mute" />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
