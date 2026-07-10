import { C, Eyebrow, StatusBadge } from "@/components/marketing/atoms";
import { WaitlistForm } from "@/components/marketing/WaitlistForm";

export const metadata = {
  title: "Hostile Agent — attack your own system, first | Pluggie",
  description:
    "An autonomous security-testing agent you point at your own application, API or MCP server. Authorized testing only. Coming soon.",
};

const PROBES: { n: string; title: string; desc: string }[] = [
  { n: "P-01", title: "Permission bypass", desc: "Escalation via claims, role confusion, gate ordering, anonymous-path leaks." },
  { n: "P-02", title: "Business-rule breaking", desc: "Negative prices, impossible states, skipped workflow transitions, constraint edge cases." },
  { n: "P-03", title: "Dangerous tool chains", desc: "Benign-looking MCP tool sequences that compose into something you never intended." },
  { n: "P-04", title: "Authorization gaps", desc: "Cross-org access, owner-row tampering, field-level write leaks, IDOR patterns." },
  { n: "P-05", title: "Data exfiltration", desc: "Over-broad projections, expand/include leaks, search surfaces that say too much." },
  { n: "P-06", title: "Destructive triggers", desc: "Unconfirmed destructive paths, purge without disclosure, cascade surprises." },
  { n: "P-07", title: "Retry & replay abuse", desc: "Idempotency gaps, double-spends, webhook replays, race-window exploitation." },
  { n: "P-08", title: "Findings, reported", desc: "Every probe ends in a structured report: reproduction, severity, suggested fix." },
];

export default function HostileAgent() {
  return (
    <>
      {/* HERO */}
      <section className="relative overflow-hidden border-b" style={{ borderColor: C.line }}>
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
        <div
          className="pointer-events-none absolute left-0 right-0 h-[120px]"
          style={{ background: "linear-gradient(180deg, transparent, rgba(67,222,131,0.05), transparent)", animation: "scan 7s linear infinite" }}
        />
        <div className="enter relative mx-auto flex max-w-[900px] flex-col items-center gap-6 px-8 pb-[88px] pt-[104px] text-center">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs tracking-[0.14em]" style={{ color: C.mute }}>
              HOSTILE AGENT <span style={{ color: C.faint }}>· BY PLUGGIE</span>
            </span>
            <StatusBadge kind="coming-soon" />
          </div>
          <h1 className="m-0 text-[clamp(40px,5.5vw,68px)] font-bold leading-[1.02] tracking-[-0.035em]">
            Attack your own system.
            <br />
            <span style={{ color: C.mute }}>Before someone else does.</span>
          </h1>
          <p className="m-0 max-w-[580px] text-[17.5px] leading-[1.65]" style={{ color: C.mute }}>
            Hostile Agent is an autonomous security-testing agent you point at your{" "}
            <span style={{ color: C.ink }}>own</span> application, API or MCP server. It actively tries to do
            what it shouldn&apos;t — and hands you the report.
          </p>
          <WaitlistForm />
          <span className="font-mono text-[11px]" style={{ color: C.faint }}>
            no pricing yet · no screenshots yet · it isn&apos;t built yet — that&apos;s the point of a waitlist
          </span>
        </div>
      </section>

      {/* AUTHORIZED FRAME */}
      <section className="border-b" style={{ borderColor: C.line, background: "rgba(67,222,131,0.03)" }}>
        <div className="mx-auto flex max-w-[900px] flex-wrap items-start gap-5 px-8 py-10">
          <span
            className="mt-0.5 flex-shrink-0 rounded-[4px] px-3 py-2 font-mono text-[13px]"
            style={{ color: C.accent, border: `1px solid rgba(67,222,131,0.4)` }}
          >
            AUTHORIZED USE ONLY
          </span>
          <p className="m-0 text-[14.5px] leading-[1.7]" style={{ color: C.mute }}>
            Hostile Agent is a defensive tool for authorized security assessment — the agent-era equivalent
            of a pentest platform. It runs against systems{" "}
            <span style={{ color: C.ink }}>you own or are explicitly authorized to test</span>, with scoped
            credentials you provide. Finding your gaps before attackers do is the entire product.
          </p>
        </div>
      </section>

      {/* THREAT CLASSES */}
      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto max-w-[1100px] px-8 py-20">
          <div className="mb-3 flex items-baseline gap-5">
            <span className="font-mono text-xs" style={{ color: C.accent }}>/ PROBES</span>
            <h2 className="m-0 text-[clamp(24px,3vw,30px)] font-bold tracking-[-0.02em]">
              What it tries, so you don&apos;t find out later
            </h2>
          </div>
          <p className="mb-12 mt-0 max-w-[560px] text-[15px] leading-[1.6]" style={{ color: C.mute }}>
            Adversarial by construction: it chains real requests against your running system and reports
            every rule that bends.
          </p>
          <div
            className="grid gap-px [grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))]"
            style={{ background: C.line, border: `1px solid ${C.line}` }}
          >
            {PROBES.map((p) => (
              <div key={p.n} className="flex flex-col gap-2.5 px-[26px] py-7" style={{ background: C.page }}>
                <span className="font-mono text-[11px]" style={{ color: C.faint }}>{p.n}</span>
                <span className="text-[15.5px] font-semibold">{p.title}</span>
                <span className="text-[13px] leading-[1.55]" style={{ color: C.mute }}>{p.desc}</span>
              </div>
            ))}
            <div className="flex flex-col justify-center gap-2.5 px-[26px] py-7" style={{ background: C.page }}>
              <span className="font-mono text-xs" style={{ color: C.accent }}>built with AgentX?</span>
              <span className="text-[13px] leading-[1.55]" style={{ color: C.mute }}>
                Natural pairing: build the backend with AgentX, then prove it holds up with Hostile Agent.
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto flex max-w-[900px] flex-col items-center gap-5 px-8 py-[88px] text-center">
          <h2 className="m-0 text-[clamp(26px,3.4vw,32px)] font-bold tracking-[-0.03em]">
            Be first on the target list. Yours.
          </h2>
          <p className="m-0 max-w-[440px] text-[15px] leading-[1.6]" style={{ color: C.mute }}>
            Join the waitlist and we&apos;ll write when there&apos;s something real to point at your staging
            environment.
          </p>
          <WaitlistForm />
        </div>
      </section>
    </>
  );
}
