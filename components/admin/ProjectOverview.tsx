import Link from "next/link";
import { ArrowUpRight, Inbox, Table2, Workflow } from "lucide-react";
import { ago, BrandTile, ConnectorHealth, Dot, Metric } from "./fleet-util";
import { EndpointField } from "./EndpointField";

/**
 * The project dashboard — a backend's front door and operations overview.
 * Opens with the two endpoints that define the project (delivery API + MCP),
 * then scale + health, the collections it exposes, and what happened lately.
 */
export interface OverviewCollection {
  name: string;
  displayName: string;
  entries: number;
  fields: number;
  publicWrite: boolean;
  workflow: boolean;
  unhandled: number;
  lastActivity: string | null;
}

export interface ActivityItem {
  actor: string;
  action: string;
  target: string;
  when: string;
}

export interface ProjectOverviewProps {
  projectId: string;
  name: string;
  initial: string;
  icon?: string | null;
  logoUrl?: string | null;
  brand: string;
  brandInk: string;
  deliveryBase: string;
  mcpEndpoint: string;
  collections: OverviewCollection[];
  connectors: { type: string; status: string }[];
  entries: number;
  unhandled: number;
  activity: ActivityItem[];
}

export function ProjectOverview(p: ProjectOverviewProps) {
  const hasCollections = p.collections.length > 0;

  return (
    <div className="flex flex-col gap-8">
      {/* Identity */}
      <div className="flex items-center gap-3.5">
        <BrandTile brand={p.brand} brandInk={p.brandInk} initial={p.initial} icon={p.icon} logoUrl={p.logoUrl} size={44} />
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="display truncate text-xl font-semibold">{p.name}</h1>
            <span
              className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em]"
              style={{ color: "var(--color-accent)" }}
            >
              <Dot status="live" live />
              live
            </span>
          </div>
          <p className="m-0 font-mono text-[11px] text-line-strong">prj_{p.projectId.slice(0, 8)}</p>
        </div>
      </div>

      {/* Front door: the two endpoints that define the backend */}
      <section className="rounded-xl border border-line bg-card p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <EndpointField label="Delivery API" value={p.deliveryBase} />
          <EndpointField label="MCP endpoint" value={p.mcpEndpoint} />
        </div>
        <p className="mt-3.5 text-[12.5px] leading-relaxed text-ink-mute">
          Point your agent at the MCP endpoint to define the data model; read the published content from the
          delivery API. Grab a scoped token in{" "}
          <Link href={`/admin/${p.projectId}/settings`} className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
            Settings
          </Link>
          .
        </p>
      </section>

      {/* Operations strip */}
      <section className="flex flex-wrap items-center gap-x-8 gap-y-4 rounded-xl border border-line bg-card px-5 py-4">
        <Metric value={p.collections.length} label="collections" />
        <Metric value={p.entries} label="entries" />
        {p.unhandled > 0 && (
          <Metric
            value={<span style={{ color: "var(--color-accent)" }}>{p.unhandled}</span>}
            label="unhandled"
          />
        )}
        <span className="hidden h-9 w-px bg-line sm:block" />
        <div className="flex flex-col gap-1">
          <ConnectorHealth connectors={p.connectors} />
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-line-strong">
            connectors
          </span>
        </div>
      </section>

      {/* Collections + activity */}
      <div className="grid gap-8 lg:grid-cols-[1.7fr_1fr]">
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="section-label">Collections</h2>
            <span className="font-mono text-[11px] text-line-strong">
              {p.collections.length} defined
            </span>
          </div>
          {hasCollections ? (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {p.collections.map((c) => (
                <Link
                  key={c.name}
                  href={`/admin/${p.projectId}/${c.name}`}
                  className="group flex flex-col gap-2 rounded-xl border border-line bg-card p-4 transition-colors hover:border-line-strong"
                >
                  <div className="flex items-center gap-2">
                    {c.publicWrite ? (
                      <Inbox className="h-4 w-4" style={{ color: "var(--brand)" }} />
                    ) : (
                      <Table2 className="h-4 w-4" style={{ color: "var(--brand)" }} />
                    )}
                    <span className="display truncate text-[14px] font-semibold">{c.displayName}</span>
                    {c.workflow && <Workflow className="h-3.5 w-3.5 text-line-strong" />}
                    {c.unhandled > 0 && (
                      <span
                        className="ml-auto rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none"
                        style={{ background: "var(--brand)", color: "var(--brand-ink)" }}
                      >
                        {c.unhandled}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-ink-mute">
                      {c.entries} {c.entries === 1 ? "entry" : "entries"} · {c.fields} fields
                      {c.publicWrite ? " · form" : ""}
                    </span>
                    <span className="font-mono text-[10px] text-line-strong">{ago(c.lastActivity)}</span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="card flex flex-col items-start gap-2 p-8">
              <p className="display font-semibold">Define your first collection</p>
              <p className="max-w-sm text-sm text-ink-mute">
                Point your agent at the MCP endpoint above and describe the data model. Collections appear
                here instantly — forms, admin and delivery API included.
              </p>
              <Link
                href={`/admin/${p.projectId}/api`}
                className="mt-1 inline-flex items-center gap-1 font-mono text-[12px] text-ink hover:text-accent"
              >
                API reference <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}
        </section>

        {/* Recent activity — the backend's pulse, in transcript voice */}
        <section>
          <h2 className="section-label mb-3">Recent activity</h2>
          {p.activity.length > 0 ? (
            <ul className="flex flex-col gap-0 rounded-xl border border-line bg-card p-1.5">
              {p.activity.map((a, i) => (
                <li key={i} className="flex items-baseline gap-2.5 rounded-lg px-2.5 py-2 font-mono text-[11px] leading-relaxed">
                  <span className="shrink-0 text-line-strong">{a.when}</span>
                  <span className="shrink-0" style={{ color: "var(--color-ink-mute)" }}>{a.actor}</span>
                  <span className="truncate text-ink">
                    {a.action}
                    {a.target ? <span className="text-ink-mute"> {a.target}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-xl border border-line bg-card p-6 text-center">
              <p className="font-mono text-[11px] text-ink-mute">no activity yet</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
