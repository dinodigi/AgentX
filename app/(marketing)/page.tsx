import Link from "next/link";
import { C, Eyebrow, CTA, SectionHead, StatusBadge } from "@/components/marketing/atoms";
import { Reveal } from "@/components/marketing/Reveal";
import { Transcript } from "@/components/marketing/Transcript";
import { HeroBackdrop } from "@/components/marketing/HeroBackdrop";
import { CountUp } from "@/components/marketing/CountUp";

export const metadata = {
  title: "Pluggie — tools for the agent era",
  description:
    "AgentX turns one MCP conversation into a branded client admin and a production delivery API. No per-project backend code.",
};

const CAPS: { n: string; title: string; desc: string; slug: string }[] = [
  { n: "001", title: "Data modeling", desc: "8 primitives, constraints, computed fields, schema diffs with plan + confirm.", slug: "data-modeling" },
  { n: "002", title: "Delivery API", desc: "Per-field public reads, query power, keyword search, i18n, strong ETags.", slug: "delivery-api" },
  { n: "003", title: "Authorization", desc: "Fail-closed presets, BYO Clerk, owner rows, org scoping — no expressions.", slug: "authorization" },
  { n: "004", title: "Automation", desc: "Events, delayed actions, schedules, declarative state machines.", slug: "automation" },
  { n: "005", title: "Payments", desc: "Stripe checkout from entry ids, order lifecycle, declarative fulfillment.", slug: "payments" },
  { n: "006", title: "Compute", desc: "Before-write hooks on your infra. AgentX never hosts your code.", slug: "compute" },
  { n: "007", title: "Realtime", desc: "Change feed + SSE with then-AND-now privacy gating.", slug: "realtime" },
  { n: "008", title: "Trust", desc: "Trash + restore, version history, audit log, plan + confirm everywhere.", slug: "trust" },
];

const cell = "flex flex-col gap-2.5 p-7";
const codeBox =
  "rounded-md p-4 font-mono text-[11.5px] leading-[1.8]";

export default function Landing() {
  return (
    <>
      {/* HERO */}
      <section className="relative overflow-hidden border-b" style={{ borderColor: C.line }}>
        <HeroBackdrop align="right" />
        <div className="relative mx-auto grid max-w-[1200px] items-center gap-12 px-8 pb-[96px] pt-28 [grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr))]">
          <div className="enter flex flex-col gap-7">
            <span
              className="inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11px] tracking-[0.12em]"
              style={{ borderColor: "rgba(67,222,131,0.3)", color: C.accent, background: "rgba(67,222,131,0.05)" }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: C.accent, animation: "pulse-dot 2.2s ease infinite" }} />
              PLUGGIE · PRIVATE BETA
            </span>
            <h1 className="m-0 text-[clamp(42px,5.4vw,68px)] font-bold leading-[1.02] tracking-[-0.035em]">
              Your agent defines the{" "}
              <span className="grad-accent">backend</span>.
              <br />
              <span style={{ color: C.mute }}>We run everything else.</span>
            </h1>
            <p className="m-0 max-w-[520px] text-lg leading-[1.6]" style={{ color: C.mute }}>
              Pluggie builds platform tools for teams who ship with AI agents.{" "}
              <Link href="/product" className="mkt-link" style={{ color: C.ink, borderBottom: "1px solid rgba(255,255,255,0.25)" }}>
                AgentX
              </Link>
              , our flagship, turns one MCP conversation into a branded client admin and a production
              delivery API — no per-project backend code, ever.
            </p>
            <div className="flex flex-wrap items-center gap-3.5">
              <CTA href="/pricing">Become a beta tester</CTA>
              <CTA href="/developers" variant="ghost">
                Read the docs →
              </CTA>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-8 gap-y-3 border-t pt-5 font-mono text-xs" style={{ color: C.faint, borderColor: C.line }}>
              <span className="flex flex-col gap-0.5">
                <span className="text-[19px] tabular-nums" style={{ color: C.ink }}><CountUp to={42} /></span>
                MCP tools
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-[19px] tabular-nums" style={{ color: C.ink }}><CountUp to={7} /></span>
                endpoint families
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-[19px] tabular-nums" style={{ color: C.ink }}><CountUp to={458} /></span>
                smoke tests green
              </span>
            </div>
          </div>
          <div className="relative" style={{ animation: "rise-soft 0.8s cubic-bezier(0.16,1,0.3,1) 0.3s both" }}>
            <div
              className="pointer-events-none absolute -inset-6 -z-10 rounded-3xl"
              style={{ background: "radial-gradient(closest-side, rgba(67,222,131,0.1), transparent 75%)" }}
            />
            <div className="relative overflow-hidden rounded-lg">
              <span className="sweep-line" />
              <Transcript />
            </div>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto max-w-[1200px] px-8 py-[88px]">
          <SectionHead index="/ 01" title="One conversation. A whole backend." />
          <div
            className="grid gap-px [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]"
            style={{ background: C.line, border: `1px solid ${C.line}` }}
          >
            <Reveal className={cell} style={{ background: C.page }}>
              <span className="font-mono text-xs" style={{ color: C.faint }}>step 01</span>
              <h3 className="m-0 text-[19px] font-semibold">Agent defines the schema</h3>
              <p className="m-0 text-sm leading-[1.6]" style={{ color: C.mute }}>
                One <span className="font-mono text-[12.5px]" style={{ color: C.accent }}>define_collection</span> call.
                8 field primitives, constraints, computed fields, workflows — a closed, self-describing
                vocabulary agents can't misuse.
              </p>
              <div className={codeBox} style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.mute }}>
                <div><span style={{ color: C.accent }}>define_collection</span>({"{"}</div>
                <div>&nbsp;&nbsp;name: <span style={{ color: C.ink }}>&quot;posts&quot;</span>,</div>
                <div>&nbsp;&nbsp;fields: {"{"} title: <span style={{ color: C.ink }}>&quot;text!&quot;</span>,</div>
                <div>&nbsp;&nbsp;&nbsp;&nbsp;slug: <span style={{ color: C.ink }}>&quot;slugify(title)&quot;</span> {"}"}</div>
                <div>{"})"}</div>
              </div>
            </Reveal>
            <Reveal className={cell} delay={0.08} style={{ background: C.page }}>
              <span className="font-mono text-xs" style={{ color: C.faint }}>step 02</span>
              <h3 className="m-0 text-[19px] font-semibold">A branded admin appears</h3>
              <p className="m-0 text-sm leading-[1.6]" style={{ color: C.mute }}>
                Your client gets a polished, Clerk-gated admin in their brand — entry forms, media, trash,
                version history. A hand-off artifact, not an internal tool.
              </p>
              <div className="overflow-hidden rounded-md" style={{ background: C.panel, border: `1px solid ${C.line}` }}>
                <div className="flex items-center gap-2 px-3.5 py-2.5" style={{ borderBottom: `1px solid ${C.line}` }}>
                  <span className="h-4 w-4 rounded-[3px]" style={{ background: C.accent }} />
                  <span className="text-xs font-semibold">Meridian Gallery</span>
                  <span className="ml-auto font-mono text-[9.5px]" style={{ color: C.faint }}>admin</span>
                </div>
                <div className="flex flex-col gap-2 px-3.5 py-3">
                  <Row label="Autumn exhibition" status="published" tone={C.accent} />
                  <Row label="Open call 2026" status="draft" tone={C.faint} muted />
                  <Row label="Artist residency" status="draft" tone={C.faint} muted />
                </div>
              </div>
            </Reveal>
            <Reveal className={cell} delay={0.16} style={{ background: C.page }}>
              <span className="font-mono text-xs" style={{ color: C.faint }}>step 03</span>
              <h3 className="m-0 text-[19px] font-semibold">The site consumes the API</h3>
              <p className="m-0 text-sm leading-[1.6]" style={{ color: C.mute }}>
                Per-field public reads, search, relations, i18n, ETags — plus a typed TS client generated
                from the live schema, compile-verified under strict.
              </p>
              <div className={codeBox} style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.mute }}>
                <div><span style={{ color: C.faint }}>GET</span> <span style={{ color: C.ink }}>/v1/posts?locale=fr</span></div>
                <div><span style={{ color: C.accent }}>200</span> <span style={{ color: C.faint }}>etag: &quot;a9f2…&quot;</span></div>
                <div>{"{ items: [{ title:"}</div>
                <div>&nbsp;&nbsp;<span style={{ color: C.ink }}>&quot;Exposition d&apos;automne&quot;</span> {"}] }"}</div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* CAPABILITY GRID */}
      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto max-w-[1200px] px-8 py-[88px]">
          <SectionHead
            index="/ 02"
            title="Everything a backend needs. Declaratively."
            right={
              <Link href="/product" className="font-mono text-[12.5px]" style={{ color: C.mute }}>
                explore AgentX →
              </Link>
            }
          />
          <div
            className="grid gap-px [grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))]"
            style={{ background: C.line, border: `1px solid ${C.line}` }}
          >
            {CAPS.map((c, i) => (
              <Reveal key={c.slug} delay={(i % 4) * 0.08}>
                <Link
                  href={`/product/capabilities#${c.slug}`}
                  className="flex h-full flex-col gap-2.5 px-6 py-7 hover:bg-[#0E1013]"
                  style={{ background: C.page, color: C.ink }}
                >
                  <span className="font-mono text-[11px]" style={{ color: C.faint }}>{c.n}</span>
                  <span className="text-base font-semibold">{c.title}</span>
                  <span className="text-[13px] leading-[1.55]" style={{ color: C.mute }}>{c.desc}</span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* BUILT FOR AGENTS */}
      <section className="border-b" style={{ borderColor: C.line, background: C.deep }}>
        <div className="mx-auto max-w-[1200px] px-8 py-[88px]">
          <div className="mb-4 flex items-baseline gap-5">
            <span className="font-mono text-xs" style={{ color: C.accent }}>/ 03</span>
            <h2 className="m-0 text-[clamp(26px,3.4vw,34px)] font-bold tracking-[-0.02em]">
              Built for agents. Not adapted for them.
            </h2>
          </div>
          <p className="mb-14 mt-0 max-w-[640px] text-base leading-[1.6]" style={{ color: C.mute }}>
            Every surface is machine-legible by design. An agent can repair its own mistakes from the error
            alone — no human in the loop.
          </p>
          <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]">
            <AgentCard title="Errors that fix themselves" foot={<>Structured <span className="font-mono" style={{ color: C.ink }}>ConstraintIssue[]</span> on every failure, from an append-only E_* registry.</>}>
              <div style={{ color: C.err }}>E_VALIDATION</div>
              <div>{"{ field: "}<span style={{ color: C.ink }}>&quot;price&quot;</span>,</div>
              <div>&nbsp;&nbsp;constraint: <span style={{ color: C.ink }}>&quot;min&quot;</span>, limit: <span style={{ color: C.ink }}>0</span>,</div>
              <div>&nbsp;&nbsp;hint: <span style={{ color: C.accent }}>&quot;price must be ≥ 0;</span></div>
              <div>&nbsp;&nbsp;<span style={{ color: C.accent }}>received -4&quot;</span> {"}"}</div>
            </AgentCard>
            <AgentCard title="Destructive = plan + confirm" foot="Schema diffs, purges, delocalization — nothing destructive runs without a plan.">
              <div><span style={{ color: C.faint }}>plan:</span></div>
              <div><span style={{ color: C.err }}>− drop field</span> <span style={{ color: C.ink }}>&quot;subtitle&quot;</span></div>
              <div>&nbsp;&nbsp;<span style={{ color: C.faint }}>(212 rows affected)</span></div>
              <div><span style={{ color: C.accent }}>+ rename</span> <span style={{ color: C.ink }}>&quot;body&quot; → &quot;content&quot;</span></div>
              <div><span style={{ color: C.faint }}>confirm to apply</span></div>
            </AgentCard>
            <AgentCard title="Safe to retry, safe to race" foot="CAS writes, multi-op transactions with dry-run, idempotency receipts on replays.">
              <div><span style={{ color: C.accent }}>update_entry_if</span>({"{"}</div>
              <div>&nbsp;&nbsp;if: {"{"} stock: <span style={{ color: C.ink }}>3</span> {"}"},</div>
              <div>&nbsp;&nbsp;set: {"{"} stock: <span style={{ color: C.ink }}>2</span> {"}"},</div>
              <div>&nbsp;&nbsp;idempotencyKey: <span style={{ color: C.ink }}>&quot;ord_91&quot;</span> {"})"}</div>
            </AgentCard>
          </div>
        </div>
      </section>

      {/* PRODUCT FAMILY */}
      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto max-w-[1200px] px-8 py-[88px]">
          <SectionHead index="/ 04" title="The product family" />
          <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]">
            <Reveal>
              <Link
                href="/product"
                className="lift flex h-full flex-col gap-[18px] rounded-[10px] p-10"
                style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.1)`, color: C.ink }}
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-bold tracking-[-0.02em]">AgentX</span>
                  <StatusBadge kind="live" />
                </div>
                <p className="m-0 text-[15px] leading-[1.6]" style={{ color: C.mute }}>
                  The MCP-native backend platform. An agent defines the data model; a branded admin and a
                  delivery API appear. Bring your own Clerk, Resend and Stripe.
                </p>
                <span className="mt-auto font-mono text-[12.5px]" style={{ color: C.accent }}>explore →</span>
              </Link>
            </Reveal>
            <Reveal delay={0.08}>
              <Link
                href="/hostile-agent"
                className="lift flex h-full flex-col gap-[18px] rounded-[10px] p-10"
                style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.1)`, color: C.ink }}
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-bold tracking-[-0.02em]">Hostile Agent</span>
                  <StatusBadge kind="coming-soon" />
                </div>
                <p className="m-0 text-[15px] leading-[1.6]" style={{ color: C.mute }}>
                  An autonomous security-testing agent for systems you own. It tries to break your rules
                  before someone else does — and reports what it finds.
                </p>
                <span className="mt-auto font-mono text-[12.5px]" style={{ color: C.mute }}>join the waitlist →</span>
              </Link>
            </Reveal>
          </div>
        </div>
      </section>

      {/* CTA BAND */}
      <section
        className="border-b"
        style={{ borderColor: C.line, background: "radial-gradient(ellipse 50% 80% at 50% 100%, rgba(67,222,131,0.08), transparent 70%)" }}
      >
        <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-6 px-8 py-24 text-center">
          <Eyebrow>PRIVATE BETA</Eyebrow>
          <h2 className="m-0 max-w-[640px] text-[clamp(32px,4vw,48px)] font-bold tracking-[-0.03em]">
            Give your agent a backend it can actually drive.
          </h2>
          <p className="m-0 max-w-[480px] text-base leading-[1.6]" style={{ color: C.mute }}>
            We&apos;re onboarding a small group of agencies and AI builders. Deployed, tested, and running
            production client sites today.
          </p>
          <div className="mt-2">
            <CTA href="/pricing" size="lg">Become a beta tester</CTA>
          </div>
        </div>
      </section>
    </>
  );
}

function Row({ label, status, tone, muted }: { label: string; status: string; tone: string; muted?: boolean }) {
  return (
    <div className="flex justify-between text-[11.5px]" style={muted ? { color: C.mute } : undefined}>
      <span>{label}</span>
      <span className="font-mono text-[9.5px]" style={{ color: tone }}>{status}</span>
    </div>
  );
}

function AgentCard({ title, children, foot }: { title: string; children: React.ReactNode; foot: React.ReactNode }) {
  return (
    <Reveal>
      <div className="lift relative h-full overflow-hidden rounded-lg" style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.1)` }}>
        <span className="sweep-line" />
        <div className="px-[18px] py-3.5 text-sm font-semibold" style={{ borderBottom: `1px solid ${C.line}` }}>
          {title}
        </div>
        <div className="px-[18px] py-[18px] font-mono text-[11.5px] leading-[1.8]" style={{ color: C.mute }}>
          {children}
        </div>
        <div className="px-[18px] py-3 text-[12.5px]" style={{ borderTop: `1px solid ${C.line}`, color: C.mute }}>
          {foot}
        </div>
      </div>
    </Reveal>
  );
}
