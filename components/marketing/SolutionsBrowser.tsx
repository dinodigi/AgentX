"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { C, Eyebrow } from "./atoms";

/**
 * Solutions by use case (Solutions.dc.html). Tab row + a two-column body that
 * swaps on hash change: the pitch + shipped-capability checklist on the left, a
 * real mechanic terminal on the right. Every claim maps to CAPABILITIES.md.
 */
interface Sol {
  id: string;
  title: string;
  headline: string;
  body: string;
  points: string[];
  mechLabel: string;
  mech: string;
}

const SOLS: Sol[] = [
  {
    id: "agencies",
    title: "Agencies",
    headline: "Hand your client an admin that looks like you built it for them. Because you did.",
    body: "Every AgentX project ships a branded, Clerk-gated admin — the client's name, logo and color, your craft. It's the artifact you hand over at the end of the build: entry forms generated from the schema, media, trash, version history, an inbox with unhandled badges. No CMS licensing, no admin to maintain per client.",
    points: [
      "Branded per project: name, logo, color — set in Appearance, applied everywhere",
      "Teaching empty states — clients learn the admin without a manual",
      "Version history and trash mean client mistakes are your 30-second fix",
      "Connector health dots: Clerk, Resend, Stripe status at a glance",
    ],
    mechLabel: "the hand-off, in practice",
    mech: `project: Meridian Gallery
├─ admin.agentx.dev/meridian     ← client works here
│    branding: { color: "#7A3FF2", logo: ✓ }
│    members: 3 · connectors: clerk ✓ resend ✓
└─ /v1 delivery API              ← their site reads here
     collections: works · shows · press

your code shipped: 0 lines of backend`,
  },
  {
    id: "ai-builders",
    title: "AI builders",
    headline: "The backend your agent can drive end-to-end. No human in the loop.",
    body: "AgentX is MCP-native, not MCP-wrapped. All 42 tools are self-describing; every error carries structured ConstraintIssue[] with fix hints; destructive changes return a plan and wait for confirm. An agent can define the schema, seed content, wire automations, generate a typed client and repair its own mistakes — from the tool surface alone.",
    points: [
      "42 tools, closed vocabulary — discoverable via list_field_types, describe_collection",
      "Machine-readable E_* errors with hints: agents self-repair from the response",
      "Idempotency keys and CAS writes: retries and races are safe by default",
      "transact with dryRun: plan a multi-op change before committing it",
    ],
    mechLabel: "self-repair loop · real transcript shape",
    mech: `agent ▸ create_entry({ price: -4 })
agentx ◂ E_VALIDATION
  { field: "price", constraint: "min",
    limit: 0, hint: "must be ≥ 0; received -4" }
agent ▸ create_entry({ price: 49 })
agentx ◂ ok · ent_x92

no human touched this exchange`,
  },
  {
    id: "content-sites",
    title: "Content sites",
    headline: "Editorial delivery with the boring parts done right.",
    body: "Rich text, media with on-demand image transforms, GIN-indexed keyword search, per-field i18n with locale fallback, and strong ETags on every read. Model a magazine, a portfolio, a docs site — the delivery API serves exactly the fields you mark public, one flat string per locale.",
    points: [
      "?locale=fr — localized fields serve one flat string with per-variant fallback",
      "Image transforms: ?w=&h=&fit=&format= with 1-yr-immutable cached derivatives",
      "?q= keyword search over the public-searchable subset",
      "Near-realtime change feed for preview panes and cache busting",
    ],
    mechLabel: "GET /v1 · editorial read",
    mech: `GET /v1/articles?q=harvest&locale=fr&select=title,hero
200 · etag "c41a…"
{ items: [{
  title: "La récolte d'automne",
  hero: "/v1/assets/ast_22/image?w=1200&format=webp"
}] }`,
  },
  {
    id: "membership",
    title: "Membership",
    headline: "Gated content and member-owned rows, without writing auth code.",
    body: "Bring your Clerk issuer — one paste of a publishable key. Members authenticate with their JWT; owner rows are server-stamped and tamper-proof; read/write presets gate collections per audience. Org scoping turns one project into a per-team space with row-level enforcement on every operation.",
    points: [
      'read: "authenticated" — one word gates a collection to members',
      "ownerField server-stamped; stripped on PATCH and the anonymous path",
      'Claim rules: { claim: "tier", equals: "pro" } for premium content',
      "Org scoping: access.org enforces team rows on every read and write",
    ],
    mechLabel: "access ladder · member content",
    mech: `collections.memberPosts.access: {
  read:  "authenticated",
  write: "owner"
}
collections.proGuides.access: {
  read: { claim: "tier", equals: "pro" }
}

X-User-Token: eyJhb…   // their Clerk JWT, your issuer`,
  },
  {
    id: "commerce",
    title: "Commerce",
    headline: "Sellable collections with a checkout that never trusts the client.",
    body: "Declare checkout on a collection with a price field. Your site POSTs a cart of entry ids; AgentX looks up prices server-side, creates a pending order, and hands off to Stripe Checkout. Signed webhooks flip orders paid or expired exactly once; fulfillment is declarative events — a confirmation email, a webhook to your fulfillment endpoint.",
    points: [
      "Server-side price lookup — client amounts are never trusted",
      "Pending-order-first: every session is accounted for before Stripe sees it",
      "whsec-verified webhook ingestion with rotation and replay bounds",
      "Order lifecycle CAS flips proven exactly-once",
    ],
    mechLabel: "cart → checkout → fulfillment",
    mech: `site ▸ POST /v1/checkout { items: [{ id: "ent_x92", qty: 2 }] }
     ◂ 303 → stripe checkout session

stripe ▸ checkout.session.completed (signed)
order  ◂ pending → paid
event  ▸ email "receipt" → customer
event  ▸ webhook → your-fulfillment.com/ship`,
  },
];

export function SolutionsBrowser() {
  const [current, setCurrent] = useState("agencies");
  useEffect(() => {
    const sync = () => {
      const id = window.location.hash.slice(1);
      if (SOLS.some((s) => s.id === id)) setCurrent(id);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const d = SOLS.find((s) => s.id === current)!;

  return (
    <>
      <section className="border-b" style={{ borderColor: C.line }}>
        <div className="mx-auto flex max-w-[1200px] flex-col gap-5 px-8 pb-0 pt-20">
          <Eyebrow>SOLUTIONS</Eyebrow>
          <h1 className="m-0 max-w-[700px] text-[clamp(36px,4.5vw,54px)] font-bold leading-[1.05] tracking-[-0.03em]">
            By use case, not by feature.
          </h1>
          <p className="mb-10 mt-0 max-w-[560px] text-[17px] leading-[1.6]" style={{ color: C.mute }}>
            Everything below is what AgentX genuinely serves today — every claim maps to a shipped capability.
          </p>
          <div className="flex flex-wrap gap-1">
            {SOLS.map((s) => {
              const on = s.id === current;
              return (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  onClick={() => setCurrent(s.id)}
                  className="px-[18px] py-3 font-mono text-[12.5px]"
                  style={{ color: on ? C.accent : C.mute, borderBottom: `2px solid ${on ? C.accent : "transparent"}` }}
                >
                  {s.title}
                </a>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-b" style={{ borderColor: C.line, minHeight: "55vh" }}>
        <div
          key={current}
          className="mx-auto grid max-w-[1200px] items-start gap-12 px-8 pb-20 pt-16 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]"
          style={{ animation: "leaf-in 0.45s cubic-bezier(0.16,1,0.3,1)" }}
        >
          <div className="flex flex-col gap-[22px]">
            <h2 className="m-0 text-[clamp(24px,3vw,32px)] font-bold leading-[1.15] tracking-[-0.02em]">
              {d.headline}
            </h2>
            <p className="m-0 text-base leading-[1.7]" style={{ color: C.mute }}>{d.body}</p>
            <div className="mt-2 flex flex-col gap-3">
              {d.points.map((p) => (
                <div key={p} className="flex items-baseline gap-3">
                  <span className="flex-shrink-0 font-mono text-xs" style={{ color: C.accent }}>✓</span>
                  <span className="text-[14.5px] leading-[1.55]" style={{ color: "#C7CCC9" }}>{p}</span>
                </div>
              ))}
            </div>
            <Link
              href="/pricing"
              className="mkt-cta mt-2.5 self-start rounded-[4px] px-5 py-3 font-mono text-[12.5px] font-semibold"
            >
              Become a beta tester
            </Link>
          </div>
          <div
            className="overflow-hidden rounded-lg lg:sticky lg:top-24"
            style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.1)` }}
          >
            <div className="px-4 py-2.5 font-mono text-[11px]" style={{ borderBottom: `1px solid ${C.line}`, color: C.faint }}>
              {d.mechLabel}
            </div>
            <div className="whitespace-pre-wrap p-5 font-mono text-xs leading-[1.9]" style={{ color: C.mute }}>
              {d.mech}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
