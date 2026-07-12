import { C, Eyebrow } from "@/components/marketing/atoms";
import { BetaRequestForm } from "@/components/marketing/BetaRequestForm";
import { HeroBackdrop } from "@/components/marketing/HeroBackdrop";

export const metadata = {
  title: "Pricing — $19/project, workspace free | Pluggie",
  description:
    "Free workspace and a capped sandbox. Paid projects: $19/mo on your own keys, $29/mo fully managed. Self-serve is in private beta.",
};

interface Tier {
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  points: string[];
  highlight?: boolean;
  chip?: string;
}

const TIERS: Tier[] = [
  {
    name: "Sandbox",
    price: "$0",
    cadence: "one per workspace",
    blurb: "For trying things out — real platform, hard caps.",
    points: [
      "Shared infrastructure",
      "1,000 entries · 20 collections · 100 MB media",
      "All 42 agent tools + delivery API",
      "Upgrade in place when it gets real",
    ],
  },
  {
    name: "Bring your own keys",
    price: "$19",
    cadence: "per project / month",
    blurb: "Your Neon, R2, Clerk, Resend, Stripe — we orchestrate, you hold the keys.",
    points: [
      "Your infra, your data, your bills",
      "Isolated database + storage per project",
      "Dev twin = a second project, free to make",
      "Ceilings sized for abuse, not product limits",
    ],
    highlight: true,
    chip: "MOST CONTROL",
  },
  {
    name: "Managed",
    price: "$29",
    cadence: "per project / month",
    blurb: "Same isolation, our org — a dedicated database and bucket, provisioned in one click.",
    points: [
      "Dedicated Neon database + R2 bucket",
      "Zero connector setup — we hold the keys",
      "Deleting the project tears the infra down",
      "Same ceilings as BYO",
    ],
    chip: "LEAST SETUP",
  },
];

export default function Pricing() {
  return (
    <>
      <section className="relative overflow-hidden border-b" style={{ borderColor: C.line }}>
        <HeroBackdrop align="center" />
        <div className="enter relative mx-auto flex max-w-[900px] flex-col items-center gap-5 px-8 pb-[72px] pt-[92px] text-center">
          <Eyebrow>PRICING · PRIVATE BETA</Eyebrow>
          <h1 className="m-0 text-[clamp(36px,4.5vw,54px)] font-bold leading-[1.05] tracking-[-0.03em]">
            Workspace free.
            <br />
            <span style={{ color: C.mute }}>Pay per project.</span>
          </h1>
          <p className="m-0 max-w-[560px] text-[16.5px] leading-[1.65]" style={{ color: C.mute }}>
            A project is one application — one isolated database, one storage plane, one agent surface.
            Flat price, generous ceilings, no metered surprises. Self-serve is still private beta: we
            onboard by hand, and beta testers keep these prices.
          </p>
        </div>
      </section>

      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto grid max-w-[1100px] items-stretch gap-6 px-8 py-[72px] [grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr))]">
          {TIERS.map((t) => (
            <div
              key={t.name}
              className="relative flex flex-col gap-5 rounded-xl p-8"
              style={{
                background: C.panel,
                border: `1px solid ${t.highlight ? "rgba(67,222,131,0.35)" : C.line}`,
              }}
            >
              {t.chip && (
                <span
                  className="absolute -top-[11px] left-8 rounded-[3px] px-2.5 py-1 font-mono text-[10px] font-semibold tracking-[0.1em]"
                  style={
                    t.highlight
                      ? { background: C.accent, color: C.page }
                      : { background: C.page, color: C.mute, border: `1px solid ${C.line}` }
                  }
                >
                  {t.chip}
                </span>
              )}
              <div className="flex flex-col gap-1.5">
                <span className="text-[19px] font-bold tracking-[-0.01em]">{t.name}</span>
                <div className="flex items-baseline gap-2">
                  <span className="text-[34px] font-bold tracking-[-0.03em]" style={{ color: t.highlight ? C.accent : undefined }}>
                    {t.price}
                  </span>
                  <span className="font-mono text-[11.5px]" style={{ color: C.mute }}>
                    {t.cadence}
                  </span>
                </div>
                <p className="m-0 text-[13.5px] leading-[1.55]" style={{ color: C.mute }}>
                  {t.blurb}
                </p>
              </div>
              <div className="flex flex-col gap-2.5">
                {t.points.map((p) => (
                  <div key={p} className="flex items-baseline gap-3">
                    <span className="font-mono text-xs" style={{ color: C.accent }}>
                      ✓
                    </span>
                    <span className="text-sm" style={{ color: "#C7CCC9" }}>
                      {p}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto grid max-w-[1000px] items-start gap-12 px-8 py-[72px] [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
          <div className="flex flex-col gap-4">
            <Eyebrow>THE BETA DEAL</Eyebrow>
            <h2 className="m-0 text-[26px] font-bold leading-[1.15] tracking-[-0.02em]">
              Hand-onboarded now,
              <br />
              <span style={{ color: C.mute }}>these prices locked when we launch.</span>
            </h2>
            <p className="m-0 max-w-[440px] text-[15px] leading-[1.65]" style={{ color: C.mute }}>
              We&apos;re onboarding agencies and AI builders who&apos;ll push on real projects. You get the
              full platform and a direct line to the team; we get honest feedback and tolerance for
              edges.
            </p>
          </div>
          <BetaRequestForm />
        </div>
      </section>
    </>
  );
}
