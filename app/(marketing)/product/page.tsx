import Link from "next/link";
import { C, Eyebrow, CTA, StatusBadge } from "@/components/marketing/atoms";
import { HeroBackdrop } from "@/components/marketing/HeroBackdrop";
import { Reveal } from "@/components/marketing/Reveal";

export const metadata = {
  title: "AgentX — the backend your agent builds over MCP | Pluggie",
  description:
    "Point an agent at AgentX and describe the project. It defines the schema with 42 self-describing tools; a branded admin and a delivery API appear.",
};

const BEATS: { glyph: string; title: string; body: string }[] = [
  {
    glyph: "→",
    title: "Agents write in",
    body: "A closed tool vocabulary with structured errors and fix hints. Destructive operations return a plan and wait for confirm. Idempotent, CAS-safe, transactional.",
  },
  {
    glyph: "▣",
    title: "Clients work in",
    body: "A branded, Clerk-gated admin generated from the schema — forms, media, trash, versions, audit. The hand-off artifact your agency gives the client.",
  },
  {
    glyph: "←",
    title: "Sites read out",
    body: "A public delivery API with per-field read projection, search, i18n, image transforms and a near-realtime change feed — plus a generated typed TS client.",
  },
];

const AREAS: { n: string; title: string; desc: string; slug: string }[] = [
  { n: "001", title: "Data modeling", desc: "8 primitives · constraints · computed fields · localized fields · schema evolution with plan + confirm", slug: "data-modeling" },
  { n: "002", title: "Delivery API", desc: "per-field public reads · filters, expand, reverse embeds · keyword search · ?locale= · strong ETags", slug: "delivery-api" },
  { n: "003", title: "Authorization", desc: "fail-closed presets · BYO Clerk issuer · owner rows · org scoping · field-level writes", slug: "authorization" },
  { n: "004", title: "Automation", desc: "events → webhook/email · delayed actions · recurring schedules · declarative state machines", slug: "automation" },
  { n: "005", title: "Payments", desc: "BYO Stripe · declarative checkout · signed webhooks · order lifecycle · fulfillment via events", slug: "payments" },
  { n: "006", title: "Compute", desc: "before-write hooks on your infra · validate or transform · test_hook dry-run · we never host your code", slug: "compute" },
  { n: "007", title: "Realtime", desc: "append-only change feed · SSE with resume · then-AND-now privacy gating · ~2–4s worst-case lag", slug: "realtime" },
  { n: "008", title: "Trust", desc: "trash + restore · version history · audit log on every mutation · plan + confirm for anything destructive", slug: "trust" },
];

export default function AgentXHub() {
  return (
    <>
      {/* HERO */}
      <section className="relative overflow-hidden border-b" style={{ borderColor: C.line }}>
        <HeroBackdrop align="right" />
        <div className="enter relative mx-auto flex max-w-[1200px] flex-col gap-[22px] px-8 pb-[80px] pt-28">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs tracking-[0.14em]" style={{ color: C.mute }}>
              AGENTX <span style={{ color: C.faint }}>· BY PLUGGIE</span>
            </span>
            <StatusBadge kind="live" />
          </div>
          <h1 className="m-0 max-w-[820px] text-[clamp(38px,5vw,60px)] font-bold leading-[1.04] tracking-[-0.035em]">
            The backend your agent builds over{" "}
            <span className="grad-accent">MCP</span>.
          </h1>
          <p className="m-0 max-w-[620px] text-[17px] leading-[1.65]" style={{ color: C.mute }}>
            Point an agent at AgentX and describe the project. It defines the schema with 42 self-describing
            tools; AgentX answers with a branded admin your client works in and a delivery API your site
            consumes. No per-project backend code — yours or ours.
          </p>
          <div className="mt-1.5 flex flex-wrap gap-3.5">
            <CTA href="/pricing">Become a beta tester</CTA>
            <CTA href="/developers" variant="ghost">Tool surface →</CTA>
          </div>
        </div>
      </section>

      {/* THREE BEATS */}
      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto max-w-[1200px] px-8 py-[72px]">
          <div
            className="grid gap-px [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]"
            style={{ background: C.line, border: `1px solid ${C.line}` }}
          >
            {BEATS.map((b) => (
              <div key={b.title} className="flex flex-col gap-3 p-9" style={{ background: C.page }}>
                <span className="font-mono text-[26px] font-semibold" style={{ color: C.accent }}>{b.glyph}</span>
                <h3 className="m-0 text-lg font-semibold">{b.title}</h3>
                <p className="m-0 text-sm leading-[1.6]" style={{ color: C.mute }}>{b.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* AREA BY AREA */}
      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto max-w-[1200px] px-8 py-20">
          <h2 className="mb-12 mt-0 text-[clamp(24px,3vw,32px)] font-bold tracking-[-0.02em]">
            The platform, area by area
          </h2>
          <div className="flex flex-col">
            {AREAS.map((a, i) => (
              <Link
                key={a.slug}
                href={`/product/capabilities#${a.slug}`}
                className="group relative flex flex-wrap items-baseline gap-x-5 gap-y-1.5 px-4 py-[22px] transition-colors hover:bg-[#0E1013]"
                style={{
                  borderTop: `1px solid ${C.line}`,
                  borderBottom: i === AREAS.length - 1 ? `1px solid ${C.line}` : undefined,
                  color: C.ink,
                }}
              >
                <span
                  className="absolute left-0 top-0 h-full w-[2px] origin-top scale-y-0 transition-transform duration-300 group-hover:scale-y-100"
                  style={{ background: C.accent }}
                />
                <span className="font-mono text-xs transition-colors group-hover:text-[#43DE83]" style={{ color: C.faint }}>{a.n}</span>
                <span className="min-w-[180px] text-[17px] font-semibold">{a.title}</span>
                <span className="min-w-[min(100%,280px)] flex-1 text-[13.5px]" style={{ color: C.mute }}>{a.desc}</span>
                <span className="transition-transform duration-300 group-hover:translate-x-1" style={{ color: C.accent }}>→</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* HONEST BOUNDARY */}
      <section className="border-b" style={{ borderColor: C.line, background: C.deep }}>
        <div className="mx-auto grid max-w-[1200px] items-start gap-12 px-8 py-[72px] [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
          <div className="flex flex-col gap-4">
            <Eyebrow>THE BOUNDARY</Eyebrow>
            <h2 className="m-0 text-[clamp(24px,2.8vw,30px)] font-bold tracking-[-0.02em]">
              We never host your code. On purpose.
            </h2>
            <p className="m-0 text-[15px] leading-[1.65]" style={{ color: C.mute }}>
              Business logic runs on your infrastructure as before-write hooks — HMAC-signed, strictly timed
              out, fully re-validated. No sandboxes, no rule expression language, no raw SQL escape hatch. The
              boundary is what makes the platform predictable for agents and safe for clients.
            </p>
          </div>
          <div className="flex flex-col gap-2.5 font-mono text-[12.5px]">
            <BoundaryRow ok>hooks = sync gate/transform, on your endpoint</BoundaryRow>
            <BoundaryRow ok>events = async, computed = derived, CAS = write-back</BoundaryRow>
            <BoundaryRow>hosted tenant code — rejected, not deferred</BoundaryRow>
            <BoundaryRow>raw SQL — nothing may bypass per-field publicRead</BoundaryRow>
          </div>
        </div>
      </section>

      {/* CLOSING CTA */}
      <section>
        <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-5 px-8 py-20 text-center">
          <h2 className="m-0 text-[clamp(26px,3.4vw,34px)] font-bold tracking-[-0.03em]">
            Running production client sites today.
          </h2>
          <CTA href="/pricing">Become a beta tester</CTA>
        </div>
      </section>
    </>
  );
}

function BoundaryRow({ children, ok }: { children: React.ReactNode; ok?: boolean }) {
  return (
    <div
      className="flex gap-3 rounded-md px-4 py-3"
      style={{ background: C.panel, border: `1px solid ${C.line}` }}
    >
      <span style={{ color: ok ? C.accent : C.err }}>{ok ? "✓" : "✗"}</span>
      <span style={{ color: C.mute }}>{children}</span>
    </div>
  );
}
