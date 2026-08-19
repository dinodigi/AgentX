import { C, Eyebrow } from "@/components/marketing/atoms";
import { HeroBackdrop } from "@/components/marketing/HeroBackdrop";
import { TOOL_GROUPS } from "@/lib/tool-groups";
import { MCP_TOOL_COUNT } from "@/lib/platform-facts";

export const metadata = {
  title: "Developers — the MCP tool surface | Pluggie",
  description: `${MCP_TOOL_COUNT} self-describing MCP tools, API conventions (E_* errors, ETags), and the generated typed client.`,
};


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
      <section className="relative overflow-hidden border-b" style={{ borderColor: C.line }}>
        <HeroBackdrop align="right" />
        <div className="enter relative mx-auto flex max-w-[1200px] flex-col gap-5 px-8 pb-16 pt-24">
          <Eyebrow>DEVELOPERS</Eyebrow>
          <h1 className="m-0 text-[clamp(36px,4.5vw,52px)] font-bold leading-[1.05] tracking-[-0.03em]">
            Docs for humans. And their <span className="grad-accent">agents</span>.
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
            <span className="font-mono text-sm font-normal" style={{ color: C.faint }}>
              — {MCP_TOOL_COUNT} tools, {TOOL_GROUPS.length} groups
            </span>
          </h2>
          <div
            className="grid gap-px font-mono [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]"
            style={{ background: C.line, border: `1px solid ${C.line}` }}
          >
            {TOOL_GROUPS.map((g) => (
              <div key={g.label} className="flex flex-col gap-2 px-6 py-5" style={{ background: C.page }}>
                <span className="text-[11px] tracking-[0.1em]" style={{ color: C.accent }}>{g.label}</span>
                <span className="text-[11px] leading-[1.6] not-italic" style={{ color: C.faint }}>{g.blurb}</span>
                <span className="text-xs leading-[1.9]" style={{ color: C.mute }}>{g.tools.join(" · ")}</span>
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
