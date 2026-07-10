import { C, Eyebrow } from "@/components/marketing/atoms";

export const metadata = {
  title: "Developers — the MCP tool surface | Pluggie",
  description: "42 self-describing MCP tools, API conventions (E_* errors, ETags), and the generated typed client.",
};

const GROUPS: { label: string; tools: string }[] = [
  { label: "SCHEMA", tools: "define_collection · list_collections · describe_collection · delete_collection" },
  { label: "WRITES", tools: "create_entry · update_entry · update_entry_if · delete_entry · bulk_create_entries · transact" },
  { label: "READS", tools: "query_entries · get_entry · count_entries · aggregate_entries · search_entries" },
  { label: "SAFETY NET", tools: "list_trash · restore_entry · purge_entry · empty_trash · list_entry_versions · restore_entry_version" },
  { label: "AUTOMATION", tools: "list_jobs · cancel_job · define_schedule · list_schedules · delete_schedule" },
  { label: "OBSERVABILITY", tools: "get_deliveries · refire_delivery · get_audit_log · get_changes" },
  { label: "PROJECT / META", tools: "get_project_info · list_field_types · list_connectors · get_client_code · set_locales" },
  { label: "ASSETS · PORTABILITY · COMPUTE", tools: "upload_asset · list_assets · delete_asset · export_entries · export_project · import_project · test_hook" },
];

const CONVENTIONS: { title: string; body: React.ReactNode }[] = [
  {
    title: "E_* errors",
    body: (
      <>
        Every error is <span className="font-mono" style={{ color: C.ink }}>{"{error, code}"}</span> from an
        append-only registry. Validation failures carry{" "}
        <span className="font-mono" style={{ color: C.ink }}>ConstraintIssue[]</span> with field, constraint,
        limit and a fix hint.
      </>
    ),
  },
  {
    title: "ETags & caching",
    body: (
      <>
        Strong ETags on every delivery read, <span className="font-mono" style={{ color: C.ink }}>304</span> on
        revalidate. Image derivatives serve 1-yr-immutable redirects.
      </>
    ),
  },
  {
    title: "Hooks guide",
    body: (
      <>
        Composition rules: hooks gate synchronously, events run async, computed fields derive, CAS writes back.{" "}
        <span className="font-mono" style={{ color: C.ink }}>test_hook</span> dry-runs without writing.
      </>
    ),
  },
];

export default function Developers() {
  return (
    <>
      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto flex max-w-[1200px] flex-col gap-5 px-8 pb-16 pt-20">
          <Eyebrow>DEVELOPERS</Eyebrow>
          <h1 className="m-0 text-[clamp(36px,4.5vw,52px)] font-bold leading-[1.05] tracking-[-0.03em]">
            Docs for humans. And their agents.
          </h1>
          <p className="m-0 max-w-[580px] text-[16.5px] leading-[1.6]" style={{ color: C.mute }}>
            The tool surface is self-describing — most of what&apos;s below, an agent discovers on its own.
            These pages exist for the human reviewing its work.
          </p>
        </div>
      </section>

      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto max-w-[1200px] px-8 py-16">
          <h2 className="mb-10 mt-0 text-[26px] font-bold tracking-[-0.02em]">
            The MCP tool surface{" "}
            <span className="font-mono text-sm font-normal" style={{ color: C.faint }}>— 42 tools, 8 groups</span>
          </h2>
          <div
            className="grid gap-px font-mono [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]"
            style={{ background: C.line, border: `1px solid ${C.line}` }}
          >
            {GROUPS.map((g) => (
              <div key={g.label} className="flex flex-col gap-2 px-6 py-5" style={{ background: C.page }}>
                <span className="text-[11px] tracking-[0.1em]" style={{ color: C.accent }}>{g.label}</span>
                <span className="text-xs leading-[1.9]" style={{ color: C.mute }}>{g.tools}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b" style={{ borderColor: C.line, background: C.deep }}>
        <div className="mx-auto max-w-[1200px] px-8 py-16">
          <h2 className="mb-10 mt-0 text-[26px] font-bold tracking-[-0.02em]">API conventions</h2>
          <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
            {CONVENTIONS.map((c) => (
              <div key={c.title} className="flex flex-col gap-3 rounded-lg p-6" style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.1)` }}>
                <span className="font-mono text-xs" style={{ color: C.accent }}>{c.title}</span>
                <p className="m-0 text-[13.5px] leading-[1.6]" style={{ color: C.mute }}>{c.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-6 overflow-hidden rounded-lg" style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.1)` }}>
            <div className="px-4 py-2.5 font-mono text-[11px]" style={{ borderBottom: `1px solid ${C.line}`, color: C.faint }}>
              get_client_code → typed client, generated from your live schema
            </div>
            <div className="p-5 font-mono text-[12.5px] leading-[1.9]" style={{ color: C.mute }}>
              <div>
                <span style={{ color: "#C792EA" }}>const</span> posts = <span style={{ color: "#C792EA" }}>await</span> agentx.posts.<span style={{ color: C.accent }}>query</span>({"{ filter: { published: "}<span style={{ color: C.ink }}>true</span>{" } });"}
              </div>
              <div>
                <span style={{ color: "#C792EA" }}>const</span> stream = agentx.changes.<span style={{ color: C.accent }}>stream</span>({"{ onChange: sync });"}
              </div>
              <div style={{ color: C.faint }}>// dependency-free · compile-verified under --strict · CRUD, search, uploads, checkout</div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
