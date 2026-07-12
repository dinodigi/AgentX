"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { ago, BrandTile, ConnectorHealth, sinceMonth } from "./fleet-util";
import { SuspendControl } from "./SuspendControl";
import type { PlatformProject, PlatformWorkspace } from "@/lib/platform";

/**
 * The operator console (B4): every workspace and every project on the platform,
 * in one operator-only surface — the god view. Built to scale to many tenants:
 * projects group under their workspace (collapsible), a search finds any project
 * by name/id/workspace, and attention filters surface only what needs eyes.
 * Distinct from the studio fleet (which is now per-operator).
 */

const NO_WS = "__no_workspace__";
type FilterKey = "all" | "attention" | "suspended" | "billing" | "setup";

export function PlatformConsole({
  workspaces,
  projects,
}: {
  workspaces: PlatformWorkspace[];
  projects: PlatformProject[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [view, setView] = useState<"workspace" | "activity">("workspace");
  // Many workspaces → start collapsed so the page opens as a scannable directory.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => (workspaces.length > 6 ? new Set([...workspaces.map((w) => w.id), NO_WS]) : new Set()),
  );

  const q = query.trim().toLowerCase();
  const counts = useMemo(
    () => ({
      all: projects.length,
      attention: projects.filter(needsAttention).length,
      suspended: projects.filter((p) => p.status === "suspended").length,
      billing: projects.filter((p) => p.billing === "past_due" || p.billing === "canceled").length,
      setup: projects.filter((p) => p.status === "setup").length,
    }),
    [projects],
  );

  const visible = useMemo(
    () => projects.filter((p) => matchesQuery(p, q) && passesFilter(p, filter)),
    [projects, q, filter],
  );

  const scoped = q !== "" || filter !== "all"; // narrowing active → hide empties, auto-expand
  const totalEntries = projects.reduce((s, p) => s + p.entries, 0);
  const totalReqs = projects.reduce((s, p) => s + p.requestsToday, 0);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="mx-auto max-w-[1200px] px-5 py-8 md:px-10 md:py-10">
      {/* Header + the platform's own vitals. */}
      <div className="mb-5">
        <p className="eyebrow mb-1">Operator console</p>
        <h1 className="display text-[22px] font-semibold leading-none">Platform</h1>
        <p className="mt-2 max-w-xl text-sm text-ink-mute">
          Every tenant on the platform, grouped by workspace. Opening a project here is support
          access — it is logged and visible to the tenant.
        </p>
      </div>

      <div className="mb-5 rounded-xl border border-line bg-card px-5 py-3.5">
        <p className="m-0 font-mono text-[12.5px] leading-relaxed">
          <span className="text-line-strong">platform ◂ </span>
          <Stat n={workspaces.length} unit="workspace" plural="workspaces" />
          <span className="text-ink-mute"> · </span>
          <Stat n={projects.length} unit="project" plural="projects" />
          <span className="text-ink-mute"> · </span>
          <span className="text-ink">{totalEntries.toLocaleString("en-US")}</span>
          <span className="text-ink-mute"> entries · </span>
          <span className="text-ink">{totalReqs.toLocaleString("en-US")}</span>
          <span className="text-ink-mute"> req today</span>
        </p>
      </div>

      {/* Controls — search + the view lens. */}
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-line-strong" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects, ids, workspaces…"
            className="w-full rounded-lg border border-line bg-card py-2 pl-9 pr-8 text-sm text-ink outline-none placeholder:text-line-strong focus:border-line-strong"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-line-strong hover:text-ink-mute"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex rounded-lg border border-line p-0.5">
          <SegBtn active={view === "workspace"} onClick={() => setView("workspace")}>
            By workspace
          </SegBtn>
          <SegBtn active={view === "activity"} onClick={() => setView("activity")}>
            Activity
          </SegBtn>
        </div>
      </div>

      {/* Attention filter chips. */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")} count={counts.all}>
          All
        </FilterChip>
        <FilterChip active={filter === "attention"} onClick={() => setFilter("attention")} count={counts.attention} tone="warn">
          Needs attention
        </FilterChip>
        {counts.suspended > 0 && (
          <FilterChip active={filter === "suspended"} onClick={() => setFilter("suspended")} count={counts.suspended} tone="err">
            Suspended
          </FilterChip>
        )}
        {counts.billing > 0 && (
          <FilterChip active={filter === "billing"} onClick={() => setFilter("billing")} count={counts.billing} tone="warn">
            Billing
          </FilterChip>
        )}
        {counts.setup > 0 && (
          <FilterChip active={filter === "setup"} onClick={() => setFilter("setup")} count={counts.setup}>
            In setup
          </FilterChip>
        )}
        {view === "workspace" && !scoped && (
          <button
            type="button"
            onClick={() =>
              setCollapsed((prev) =>
                prev.size > 0 ? new Set() : new Set([...workspaces.map((w) => w.id), NO_WS]),
              )
            }
            className="ml-auto font-mono text-[11px] text-line-strong hover:text-ink-mute"
          >
            {collapsed.size > 0 ? "expand all" : "collapse all"}
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState onReset={() => { setQuery(""); setFilter("all"); }} />
      ) : view === "activity" ? (
        <ul className="flex flex-col gap-2.5">
          {visible.map((p) => (
            <ProjectRow key={p.id} p={p} showWorkspace />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-2.5">
          {orderedGroups(workspaces, visible, scoped).map((g) => (
            <WorkspaceGroup
              key={g.key}
              group={g}
              open={scoped || !collapsed.has(g.key)}
              onToggle={() => toggle(g.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── grouping ─────────────────────────────────────────────────────────── */

interface Group {
  key: string;
  name: string;
  members: number | null;
  totalProjects: number;
  since: string | null;
  projects: PlatformProject[];
}

/** Workspaces (server-sorted) with their VISIBLE projects nested; the no-workspace
 * bucket trails. When narrowing, empty groups drop out. */
function orderedGroups(workspaces: PlatformWorkspace[], visible: PlatformProject[], scoped: boolean): Group[] {
  const byWs = new Map<string, PlatformProject[]>();
  for (const p of visible) {
    const key = p.workspaceId ?? NO_WS;
    const list = byWs.get(key) ?? [];
    list.push(p);
    byWs.set(key, list);
  }
  const groups: Group[] = [];
  for (const w of workspaces) {
    const list = byWs.get(w.id) ?? [];
    if (scoped && list.length === 0) continue;
    groups.push({ key: w.id, name: w.name, members: w.members, totalProjects: w.projects, since: w.createdAt, projects: list });
  }
  const orphans = byWs.get(NO_WS) ?? [];
  if (orphans.length > 0) {
    groups.push({ key: NO_WS, name: "No workspace", members: null, totalProjects: orphans.length, since: null, projects: orphans });
  }
  return groups;
}

function WorkspaceGroup({ group, open, onToggle }: { group: Group; open: boolean; onToggle: () => void }) {
  const attention = attentionLevel(group.projects);
  return (
    <section className="overflow-hidden rounded-xl border border-line">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 bg-card px-4 py-3 text-left transition-colors hover:bg-raised"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-line-strong" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-line-strong" />
        )}
        <span className="display truncate text-[14px] font-semibold text-ink">{group.name}</span>
        {attention && <AttentionDot level={attention} />}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-line-strong">
          {group.members !== null && (
            <>
              {group.members} {group.members === 1 ? "member" : "members"}
              <span className="text-ink-mute"> · </span>
            </>
          )}
          <span className="text-ink-mute">{group.projects.length}</span>
          {group.projects.length !== group.totalProjects && <span className="text-line-strong">/{group.totalProjects}</span>}
          <span className="text-ink-mute"> {group.totalProjects === 1 ? "project" : "projects"}</span>
          {group.since && <span className="hidden md:inline"> · since {sinceMonth(group.since)}</span>}
        </span>
      </button>
      {open && (
        <ul className="flex flex-col gap-2 border-t border-line bg-paper/40 p-2.5">
          {group.projects.length === 0 ? (
            <li className="px-2 py-3 font-mono text-[11px] text-line-strong">no projects yet</li>
          ) : (
            group.projects.map((p) => <ProjectRow key={p.id} p={p} />)
          )}
        </ul>
      )}
    </section>
  );
}

/* ── project row (shared by both views) ───────────────────────────────── */

function ProjectRow({ p, showWorkspace = false }: { p: PlatformProject; showWorkspace?: boolean }) {
  return (
    <li className="group relative flex items-center gap-4 overflow-hidden rounded-lg border border-line bg-card p-3.5 transition-colors hover:border-line-strong">
      <Link href={`/admin/${p.id}`} className="absolute inset-0" aria-label={`Open ${p.name}`} />
      <span
        className="pointer-events-none absolute inset-y-0 left-0 w-[3px] opacity-0 transition-opacity group-hover:opacity-100"
        style={{ background: p.brand }}
      />
      <BrandTile brand={p.brand} brandInk={p.brandInk} initial={p.initial} icon={p.icon} logoUrl={p.logoUrl} size={36} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="display truncate text-[14.5px] font-semibold text-ink">{p.name}</span>
          {p.status === "suspended" && <StateChip tone="err">suspended</StateChip>}
          {p.status === "setup" && <StateChip tone="faint">setup</StateChip>}
          {(p.billing === "past_due" || p.billing === "canceled") && (
            <StateChip tone="warn">{p.billing.replace("_", " ")}</StateChip>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-line-strong">
          {showWorkspace && (
            <>
              {p.workspaceName}
              <span className="text-ink-mute"> · </span>
            </>
          )}
          prj_{p.id.slice(0, 8)}
          <span className="text-ink-mute"> · </span>
          <span className="text-ink-soft">{p.plan ?? "legacy"}</span>
          {p.billing === "exempt" && <span> (exempt)</span>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 xl:hidden">
          <span className="font-mono text-[11px] text-ink-mute">
            {usageText(p.entries, p.caps?.entries)} entries · {usageText(p.collections, p.caps?.collections)} coll ·{" "}
            {fmtBytes(p.assetBytes)}
            {p.caps ? ` / ${fmtBytes(p.caps.assetBytes)}` : ""} media
          </span>
          <span className="md:hidden">
            <ConnectorHealth connectors={p.connectors} />
          </span>
        </div>
      </div>

      <div className="hidden items-center gap-6 xl:flex">
        <Usage value={p.entries} cap={p.caps?.entries} label="entries" />
        <Usage value={p.collections} cap={p.caps?.collections} label="collections" />
        <Usage value={p.assetBytes} cap={p.caps?.assetBytes} label="media" bytes />
        <Usage value={p.requestsToday} label="req today" />
      </div>
      <div className="hidden items-center gap-6 md:flex">
        <span className="hidden h-9 w-px bg-line xl:block" />
        <ConnectorHealth connectors={p.connectors} />
        <div className="flex min-w-[86px] flex-col items-end gap-0.5">
          <span className="font-mono text-[11px] text-ink-mute">{ago(p.lastActivity)}</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-line-strong">last write</span>
        </div>
      </div>

      <div className="relative z-10 hidden shrink-0 md:block">
        <SuspendControl projectId={p.id} name={p.name} status={p.status} />
      </div>

      <ChevronRight className="h-4 w-4 shrink-0 text-line-strong transition-transform group-hover:translate-x-0.5 group-hover:text-ink-mute" />
    </li>
  );
}

/* ── small pieces ─────────────────────────────────────────────────────── */

function Stat({ n, unit, plural }: { n: number; unit: string; plural: string }) {
  return (
    <>
      <span className="text-ink">{n}</span>
      <span className="text-ink-mute"> {n === 1 ? unit : plural}</span>
    </>
  );
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[6px] px-3 py-1.5 font-mono text-[11px] transition-colors ${
        active ? "bg-raised text-ink" : "text-ink-mute hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function FilterChip({
  active,
  onClick,
  count,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  tone?: "warn" | "err";
  children: ReactNode;
}) {
  const accent = tone === "err" ? "var(--color-err)" : tone === "warn" ? "var(--color-warn)" : "var(--color-accent)";
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors"
      style={{
        borderColor: active ? accent : "var(--color-line)",
        background: active ? `color-mix(in srgb, ${accent} 12%, transparent)` : "transparent",
        color: active ? "var(--color-ink)" : "var(--color-ink-mute)",
      }}
    >
      {children}
      <span className="font-mono text-[10.5px] tabular-nums" style={{ color: active ? accent : "var(--color-line-strong)" }}>
        {count}
      </span>
    </button>
  );
}

function EmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-card px-6 py-12 text-center">
      <p className="m-0 text-sm text-ink-mute">No projects match.</p>
      <button type="button" onClick={onReset} className="mt-2 font-mono text-[11px] text-line-strong underline hover:text-ink-mute">
        clear filters
      </button>
    </div>
  );
}

function AttentionDot({ level }: { level: "err" | "warn" }) {
  const color = level === "err" ? "var(--color-err)" : "var(--color-warn)";
  return <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: color }} title={level === "err" ? "suspended project" : "needs attention"} />;
}

function StateChip({ tone, children }: { tone: "err" | "warn" | "faint"; children: string }) {
  const color =
    tone === "err" ? "var(--color-err)" : tone === "warn" ? "var(--color-warn)" : "var(--color-line-strong)";
  return (
    <span
      className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em]"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}
    >
      {children}
    </span>
  );
}

/** A usage-vs-cap metric — warns at 80% of the plan's ceiling. */
function Usage({ value, cap, label, bytes = false }: { value: number; cap?: number; label: string; bytes?: boolean }) {
  const nearCap = cap !== undefined && cap > 0 && value / cap >= 0.8;
  const shown = bytes ? fmtBytes(value) : value.toLocaleString("en-US");
  const denom = cap === undefined ? null : bytes ? fmtBytes(cap) : fmtCount(cap);
  return (
    <span className="flex min-w-[72px] flex-col gap-0.5">
      <span className="font-mono text-[13px] tabular-nums" style={{ color: nearCap ? "var(--color-warn)" : "var(--color-ink)" }}>
        {shown}
        {denom && <span className="text-[11px] text-line-strong"> / {denom}</span>}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-mute">{label}</span>
    </span>
  );
}

/* ── predicates + formatting ──────────────────────────────────────────── */

function nearCap(p: PlatformProject): boolean {
  if (!p.caps) return false;
  return (
    p.entries / p.caps.entries >= 0.8 ||
    p.collections / p.caps.collections >= 0.8 ||
    p.assetBytes / p.caps.assetBytes >= 0.8
  );
}

function needsAttention(p: PlatformProject): boolean {
  return (
    p.status === "suspended" ||
    p.billing === "past_due" ||
    p.billing === "canceled" ||
    p.connectors.some((c) => c.status === "error") ||
    nearCap(p)
  );
}

/** Strongest attention signal in a group: red if anything suspended, else amber. */
function attentionLevel(list: PlatformProject[]): "err" | "warn" | null {
  if (list.some((p) => p.status === "suspended")) return "err";
  if (list.some(needsAttention)) return "warn";
  return null;
}

function matchesQuery(p: PlatformProject, q: string): boolean {
  if (!q) return true;
  return (
    p.name.toLowerCase().includes(q) ||
    p.id.toLowerCase().startsWith(q) ||
    p.workspaceName.toLowerCase().includes(q)
  );
}

function passesFilter(p: PlatformProject, filter: FilterKey): boolean {
  switch (filter) {
    case "attention":
      return needsAttention(p);
    case "suspended":
      return p.status === "suspended";
    case "billing":
      return p.billing === "past_due" || p.billing === "canceled";
    case "setup":
      return p.status === "setup";
    default:
      return true;
  }
}

/** Compact count for cap denominators: 250000 → 250k. */
function fmtCount(n: number): string {
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
  return n.toLocaleString("en-US");
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(n % (1024 * 1024 * 1024) === 0 ? 0 : 1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return n === 0 ? "0" : `${n} B`;
}

function usageText(value: number, cap: number | undefined): string {
  return cap ? `${value.toLocaleString("en-US")}/${fmtCount(cap)}` : value.toLocaleString("en-US");
}
