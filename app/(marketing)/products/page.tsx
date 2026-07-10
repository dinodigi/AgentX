import Link from "next/link";
import { C, Eyebrow, StatusBadge } from "@/components/marketing/atoms";

export const metadata = {
  title: "Products — Pluggie",
  description: "AgentX (live) and Hostile Agent (coming soon) — tools for teams who build with agents.",
};

const cardBase =
  "grid items-center gap-10 rounded-xl p-12 [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]";
const snippet = "rounded-lg p-5 font-mono text-xs leading-[1.9]";

export default function Products() {
  return (
    <>
      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto flex max-w-[1200px] flex-col gap-5 px-8 pb-[72px] pt-[88px]">
          <Eyebrow>PRODUCTS</Eyebrow>
          <h1 className="m-0 max-w-[720px] text-[clamp(36px,4.5vw,56px)] font-bold leading-[1.05] tracking-[-0.03em]">
            Tools for teams who build with agents.
          </h1>
          <p className="m-0 max-w-[560px] text-[17px] leading-[1.6]" style={{ color: C.mute }}>
            One shipping, one on the bench. Both built on the same conviction: agents do the building,
            platforms should be machine-legible.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-8 pb-24 pt-[72px]">
          <Link
            href="/product"
            className={`${cardBase} hover:border-[rgba(67,222,131,0.5)]`}
            style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.1)`, color: C.ink }}
          >
            <div className="flex flex-col gap-[18px]">
              <div className="flex items-center gap-3">
                <span className="text-[30px] font-bold tracking-[-0.02em]">AgentX</span>
                <StatusBadge kind="live" />
              </div>
              <p className="m-0 text-base leading-[1.65]" style={{ color: C.mute }}>
                The MCP-native backend platform. Your agent defines a data model and gets back a branded
                client admin and a production delivery API — authorization, automation, payments and compute
                included, with none of your code hosted by us.
              </p>
              <div className="flex flex-wrap gap-5 font-mono text-[11.5px]" style={{ color: C.faint }}>
                <span><span style={{ color: C.ink }}>42</span> MCP tools</span>
                <span><span style={{ color: C.ink }}>8</span> field primitives</span>
                <span><span style={{ color: C.ink }}>458</span> tests green</span>
              </div>
              <span className="font-mono text-[13px]" style={{ color: C.accent }}>explore AgentX →</span>
            </div>
            <div className={snippet} style={{ background: C.page, border: `1px solid ${C.line}`, color: C.mute }}>
              <div><span style={{ color: C.faint }}>agent ▸</span> <span style={{ color: C.accent }}>define_collection</span>(…)</div>
              <div><span style={{ color: C.faint }}>agentx ◂</span> admin live · /v1 live</div>
              <div><span style={{ color: C.faint }}>agent ▸</span> <span style={{ color: C.accent }}>get_client_code</span>()</div>
              <div><span style={{ color: C.faint }}>agentx ◂</span> typed TS client, strict-verified</div>
            </div>
          </Link>

          <Link
            href="/hostile-agent"
            className={`${cardBase} hover:border-[rgba(255,255,255,0.3)]`}
            style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.1)`, color: C.ink }}
          >
            <div className="flex flex-col gap-[18px]">
              <div className="flex items-center gap-3">
                <span className="text-[30px] font-bold tracking-[-0.02em]">Hostile Agent</span>
                <StatusBadge kind="coming-soon" />
              </div>
              <p className="m-0 text-base leading-[1.65]" style={{ color: C.mute }}>
                An autonomous security-testing agent you point at your own application, API or MCP server. It
                probes permissions, business rules and tool chains — then reports the gaps before an attacker
                finds them. Authorized testing only.
              </p>
              <span className="font-mono text-[13px]" style={{ color: C.mute }}>join the waitlist →</span>
            </div>
            <div className={snippet} style={{ background: C.page, border: `1px solid ${C.line}`, color: C.mute }}>
              <div><span style={{ color: C.faint }}>probe ▸</span> escalate via role claim…</div>
              <div><span style={{ color: C.err }}>✗ blocked</span> <span style={{ color: C.faint }}>— fail-closed</span></div>
              <div><span style={{ color: C.faint }}>probe ▸</span> replay stale checkout…</div>
              <div><span style={{ color: C.warn }}>⚠ finding</span> <span style={{ color: C.faint }}>— report §3.2</span></div>
            </div>
          </Link>
        </div>
      </section>
    </>
  );
}
