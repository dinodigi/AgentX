import { C, Eyebrow } from "@/components/marketing/atoms";
import { BetaRequestForm } from "@/components/marketing/BetaRequestForm";

export const metadata = {
  title: "Private beta — request a spot | Pluggie",
  description: "AgentX runs production client sites today but isn't self-serve yet. We onboard beta testers by hand.",
};

const PERKS: { glyph: string; tone: string; text: string }[] = [
  { glyph: "✓", tone: C.accent, text: "The full platform — all 42 tools, delivery API, admin, connectors" },
  { glyph: "✓", tone: C.accent, text: "Direct line to the team that builds it" },
  { glyph: "✓", tone: C.accent, text: "Beta pricing locked in when pricing exists" },
  { glyph: "◆", tone: C.warn, text: "In exchange: real projects, honest feedback, tolerance for edges" },
];

export default function Pricing() {
  return (
    <>
      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto flex max-w-[900px] flex-col items-center gap-5 px-8 pb-[72px] pt-[88px] text-center">
          <Eyebrow>PRIVATE BETA</Eyebrow>
          <h1 className="m-0 text-[clamp(36px,4.5vw,54px)] font-bold leading-[1.05] tracking-[-0.03em]">
            No pricing page theater.
            <br />
            <span style={{ color: C.mute }}>There&apos;s no pricing yet.</span>
          </h1>
          <p className="m-0 max-w-[540px] text-[16.5px] leading-[1.65]" style={{ color: C.mute }}>
            AgentX runs production client sites today, but it isn&apos;t self-serve yet. We&apos;re onboarding
            beta testers by hand — agencies and AI builders who&apos;ll push on it for real.
          </p>
        </div>
      </section>

      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto grid max-w-[1000px] items-start gap-12 px-8 py-[72px] [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
          <div className="relative flex flex-col gap-5 rounded-xl p-10" style={{ background: C.panel, border: `1px solid rgba(67,222,131,0.35)` }}>
            <span
              className="absolute -top-[11px] left-8 rounded-[3px] px-2.5 py-1 font-mono text-[10px] font-semibold tracking-[0.1em]"
              style={{ background: C.accent, color: C.page }}
            >
              ONLY TIER
            </span>
            <div className="flex items-baseline gap-3">
              <span className="text-[26px] font-bold tracking-[-0.02em]">Beta tester</span>
              <span className="font-mono text-[13px]" style={{ color: C.accent }}>$0 during beta</span>
            </div>
            <div className="flex flex-col gap-3">
              {PERKS.map((p) => (
                <div key={p.text} className="flex items-baseline gap-3">
                  <span className="font-mono text-xs" style={{ color: p.tone }}>{p.glyph}</span>
                  <span className="text-sm" style={{ color: "#C7CCC9" }}>{p.text}</span>
                </div>
              ))}
            </div>
          </div>
          <BetaRequestForm />
        </div>
      </section>
    </>
  );
}
