import Link from "next/link";
import { Plus, Table2, FileText } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { count } from "drizzle-orm";
import { db } from "@/db";
import { collections, entries, projectConnectors } from "@/db/schema";
import { accessibleProjects } from "@/lib/access";
import { brandInk } from "@/lib/brand";

/**
 * The studio dashboard — the operator's view of every project. Ink chrome up
 * top (matching each workspace's ink rail), one card per project wearing its
 * own brand color.
 */
export default async function AdminHome() {
  const projects = await accessibleProjects();

  // Counts in grouped queries, not N-per-project.
  const [collectionCounts, entryCounts, connectorRows] = await Promise.all([
    db
      .select({ projectId: collections.projectId, n: count() })
      .from(collections)
      .groupBy(collections.projectId),
    db
      .select({ projectId: entries.projectId, n: count() })
      .from(entries)
      .groupBy(entries.projectId),
    db
      .select({
        projectId: projectConnectors.projectId,
        type: projectConnectors.type,
        status: projectConnectors.status,
      })
      .from(projectConnectors),
  ]);
  const colsById = new Map(collectionCounts.map((c) => [c.projectId, c.n]));
  const entriesById = new Map(entryCounts.map((c) => [c.projectId, c.n]));
  const connectorsById = new Map<string, { type: string; status: string }[]>();
  for (const c of connectorRows) {
    const list = connectorsById.get(c.projectId) ?? [];
    list.push({ type: c.type, status: c.status });
    connectorsById.set(c.projectId, list);
  }

  return (
    <div className="min-h-screen">
      <header className="bg-[#16130e]">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-8 py-4">
          <span className="display text-[15px] font-semibold tracking-tight text-white">
            Agent<span className="text-white/50">X</span>
          </span>
          <UserButton />
        </div>
      </header>

      <main className="page-enter mx-auto max-w-4xl px-8 py-10">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <p className="eyebrow mb-1.5">Studio</p>
            <h1 className="display text-[26px] font-semibold leading-none">
              Projects
              <span className="ml-3 align-middle text-sm font-normal text-[--color-ink-mute]">
                {projects.length}
              </span>
            </h1>
          </div>
          <Link href="/admin/new" className="btn btn-ink">
            <Plus className="h-4 w-4" />
            New project
          </Link>
        </div>

        {projects.length === 0 && (
          <div className="card p-14 text-center">
            <p className="display text-lg font-semibold">Start your first project</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-[--color-ink-mute]">
              A project gets its own branded admin, MCP token, and delivery API —
              defined by an agent, handed to a client.
            </p>
            <Link href="/admin/new" className="btn btn-ink mt-5">
              <Plus className="h-4 w-4" />
              New project
            </Link>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {projects.map((p) => {
            const color = p.branding?.primaryColor ?? "#4f46e5";
            const name = p.branding?.displayName ?? p.name;
            return (
              <Link
                key={p.id}
                href={`/admin/${p.id}`}
                className="card group overflow-hidden transition-transform hover:-translate-y-0.5"
                style={{ "--brand": color, "--brand-ink": brandInk(color) } as React.CSSProperties}
              >
                <div className="h-1 w-full" style={{ background: color }} />
                <div className="p-5">
                  <div className="flex items-center gap-3">
                    {p.branding?.logoUrl ? (
                      <img
                        src={p.branding.logoUrl}
                        alt=""
                        className="h-10 w-10 rounded-xl border border-[--color-line] object-cover"
                      />
                    ) : (
                      <div
                        className="display flex h-10 w-10 items-center justify-center rounded-xl text-[15px] font-semibold"
                        style={{ background: color, color: "var(--brand-ink)" }}
                      >
                        {name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="display truncate text-[15px] font-semibold">{name}</p>
                      <p className="truncate font-mono text-[11px] text-[--color-ink-mute]">
                        {p.id.slice(0, 8)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center gap-4 border-t border-[--color-line] pt-3 text-[12.5px] text-[--color-ink-mute]">
                    <span className="inline-flex items-center gap-1.5">
                      <Table2 className="h-3.5 w-3.5" />
                      {colsById.get(p.id) ?? 0} collections
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5" />
                      {entriesById.get(p.id) ?? 0} entries
                    </span>
                    <span className="ml-auto inline-flex items-center gap-2">
                      {(connectorsById.get(p.id) ?? []).map((c) => (
                        <span
                          key={c.type}
                          className="inline-flex items-center gap-1"
                          title={`${c.type}: ${c.status}`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              c.status === "connected" ? "bg-emerald-500" : "bg-red-500"
                            }`}
                          />
                          {c.type}
                        </span>
                      ))}
                      <span>
                        {p.createdAt.toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                      </span>
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}
