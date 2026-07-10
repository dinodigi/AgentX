import Link from "next/link";
import { C, Eyebrow } from "@/components/marketing/atoms";
import { HeroBackdrop } from "@/components/marketing/HeroBackdrop";

export const metadata = {
  title: "Company — Pluggie",
  description: "Pluggie grew out of Currents Studio, an agency shipping client sites with AI agents. Your infrastructure stays yours.",
};

export default function Company() {
  return (
    <>
      <section className="relative overflow-hidden border-b" style={{ borderColor: C.line }}>
        <HeroBackdrop align="right" />
        <div className="enter relative mx-auto flex max-w-[800px] flex-col gap-6 px-8 pb-[72px] pt-[92px]">
          <Eyebrow>COMPANY</Eyebrow>
          <h1 className="m-0 text-[clamp(36px,4.5vw,52px)] font-bold leading-[1.08] tracking-[-0.03em]">
            Built by an agency that got tired of building the same backend.
          </h1>
          <p className="m-0 text-[16.5px] leading-[1.75]" style={{ color: C.mute }}>
            Pluggie grew out of <span style={{ color: C.ink }}>Currents Studio</span>, an agency shipping
            client sites with AI agents. Every project needed the same things: a data model, an admin the
            client could actually use, an API the site could trust. So we built it once — as a platform an
            agent can drive — and started running our own client work on it. AgentX is that platform,
            dogfooded in production before it ever had a marketing site.
          </p>
          <p className="m-0 text-[16.5px] leading-[1.75]" style={{ color: C.mute }}>
            The name Pluggie reflects the thesis: your infrastructure stays yours — auth, email, payments,
            compute all plug in as connectors. We run the platform layer; we never host your code.
          </p>
        </div>
      </section>

      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto grid max-w-[800px] gap-12 px-8 py-16 [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
          <div className="flex flex-col gap-3.5">
            <span className="font-mono text-[11px] tracking-[0.1em]" style={{ color: C.faint }}>HOW WE WORK</span>
            <p className="m-0 text-[14.5px] leading-[1.7]" style={{ color: C.mute }}>
              Verification culture: every increment lands with typecheck plus a live smoke run against a real
              server. Risky changes get adversarial review. Destructive operations get a plan and a confirm —
              in the product and in how we build it.
            </p>
          </div>
          <div className="flex flex-col gap-3.5">
            <span className="font-mono text-[11px] tracking-[0.1em]" style={{ color: C.faint }}>CONTACT</span>
            <Link href="/pricing" className="font-mono text-sm" style={{ color: C.accent }}>
              hello@pluggie.dev →
            </Link>
            <p className="m-0 text-[14.5px] leading-[1.7]" style={{ color: C.mute }}>
              Beta requests, partnership questions, or just to tell us the name is silly. (Working name. We know.)
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
