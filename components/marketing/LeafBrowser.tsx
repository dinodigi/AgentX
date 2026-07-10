"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { C, CTA } from "./atoms";

/**
 * AgentX capability browser (Product Leaf.dc.html). A left rail of 8 areas +
 * a body that swaps on hash change — each area is a real mechanic (a terminal
 * transcript) plus facts and an honest boundary. Deep-linkable: /…#compute.
 */
interface Leaf {
  id: string;
  num: string;
  title: string;
  headline: string;
  body: string;
  mechLabel: string;
  mech: string;
  facts: string[];
  boundary: string;
}

const LEAVES: Leaf[] = [
  {
    id: "data-modeling",
    num: "001",
    title: "Data modeling",
    headline: "A schema vocabulary agents can't misuse.",
    body: "Eight field primitives — text, richtext, number, boolean, date, enum, asset, relation — with declarative constraints, computed fields (slugify, template, now, uuid), and per-locale variant maps. The vocabulary is closed and self-describing: an agent discovers it with list_field_types and never guesses.",
    mechLabel: "schema evolution · plan + confirm",
    mech: `agent ▸ define_collection({ name: "posts", fields: { … } })
agentx ◂ plan:
  − drop field "subtitle"        (212 rows affected)
  + rename "body" → "content"    (atomic backfill, incl. trash)
  ⚠ tighten title.max 80          (3 existing rows exceed)
agent ▸ confirm
agentx ◂ ok · schema v14 live`,
    facts: ["8 primitives, closed vocabulary", "unique / min / max / pattern + hint", "computed: slugify · template · now · uuid", "localized {locale: value} maps"],
    boundary: "Constraint tightening never silently breaks rows — define-time scans report every existing violation before you confirm. Pattern constraints are safe-regex checked at define time so runtime matching is provably bounded.",
  },
  {
    id: "delivery-api",
    num: "002",
    title: "Delivery API",
    headline: "Public reads, projected per field.",
    body: "Every collection gets /v1 endpoints with per-field publicRead projection and row-level publicFilter gates — the invariant no feature bypasses. Filters, sorting, keyset paging, select, depth-1 expand, related-field filters, reverse embeds, GIN-indexed keyword search, per-locale reads, and strong ETags.",
    mechLabel: "GET /v1 · the read surface",
    mech: `GET /v1/posts?author.name=Ada&expand=author&q=launch&locale=fr
200 · etag "9f31…" · 304 on revalidate
{ items: [{
    title: "Lancement d'automne",     // fr variant
    author: { name: "Ada" },           // expanded, own gates
  }], nextCursor: "…" }`,
    facts: ["per-field publicRead projection", "?q= search · ?locale= i18n", "strong ETags / 304", "typed TS client via get_client_code"],
    boundary: "The generated TS client is dependency-free and compile-verified under --strict against your live schema — not a hand-maintained SDK that drifts.",
  },
  {
    id: "authorization",
    num: "003",
    title: "Authorization",
    headline: "Presets, not expressions. Fail-closed, always.",
    body: "read and write accept a small ladder — public, authenticated, owner, {claim, equals} — plus any-of arrays. Owner rows are server-stamped and tamper-proof. Bring your own Clerk issuer: JWKS probed on save, end-user JWTs via X-User-Token, org/team row scoping enforced as row clauses on every operation.",
    mechLabel: "access config · declarative",
    mech: `access: {
  read:  "public",
  write: ["owner", { claim: "role", equals: "moderator" }],
  org:   { claim: "org_id", field: "team" }   // server-stamped
}

fields.internalNotes: { publicRead: false, writableBy: "none" }`,
    facts: ["fail-closed ladder", "BYO Clerk, multi-issuer", "server-stamped ownerField", "field-level writableBy"],
    boundary: "There is deliberately no rule expression language — rejected, not deferred. Presets are analyzable by agents and auditable by humans; expressions are neither.",
  },
  {
    id: "automation",
    num: "004",
    title: "Automation",
    headline: "Events, schedules and state machines — declared, not coded.",
    body: "entry.created/updated/deleted/transitioned events fire HMAC-signed webhooks or Resend emails, with when-clauses and {{field}} interpolation. Delayed actions (after: \"3d\") re-resolve config at run time. Recurring UTC schedules tick under a race-proven jobs runner. Workflows are enum-field state machines with actor gates, enforced on every write path.",
    mechLabel: "workflow · declarative state machine",
    mech: `workflow: {
  field: "status",
  transitions: {
    "draft → review":    { actor: "authenticated" },
    "review → published": { actor: { claim: "role", equals: "editor" },
                            actions: [{ email: "author", after: "0m" }] }
  }
}
// CAS transitions proven exactly-once under 5-way races`,
    facts: ["webhook + email actions, HMAC-signed", "delayed actions 1m–365d", "UTC schedules, CAS-advanced", "delivery log + re-fire"],
    boundary: "Delayed payloads carry references, not snapshots — if you edit or disable the automation before it fires, the run re-checks and skips. No stale side effects.",
  },
  {
    id: "payments",
    num: "005",
    title: "Payments",
    headline: "Checkout from a cart of entry ids.",
    body: "Stripe as a BYO connector — keys AES-GCM encrypted, never exposed over MCP, no SDK. Declare checkout on a collection with a price field; POST /v1/checkout looks prices up server-side (client amounts are never trusted), creates the session pending-order-first, and signed webhook ingestion flips orders paid/expired with CAS. Fulfillment is just events.",
    mechLabel: "POST /v1/checkout · server-side pricing",
    mech: `POST /v1/checkout
{ items: [{ id: "ent_x92", qty: 2 }] }

→ price looked up server-side from priceField
→ order created: status "pending"
→ 303 stripe.com/c/pay/cs_…

webhook ▸ checkout.session.completed (whsec-verified)
order   ◂ pending → paid   (CAS, exactly once)`,
    facts: ["BYO Stripe keys, AES-GCM at rest", "sellable ⇒ public, re-checked", "one-click webhook provisioning", "fulfillment via existing events"],
    boundary: "One-time checkout only today. Subscriptions and refunds live in your app layer — we'd rather ship a narrow, verified payment path than a wide, fragile one.",
  },
  {
    id: "compute",
    num: "006",
    title: "Compute",
    headline: "Your code, on your infra. We never host it.",
    body: "Before-write hooks POST the candidate entry to your endpoint — HMAC-signed, https-only, strict timeout, fail-open or fail-closed per your config. Validate or transform; output is fully re-validated and can never move ownership. Enforced at the single choke point every write path shares: singles, bulks, transactions.",
    mechLabel: "before-write hook · signed sync gate",
    mech: `beforeCreate ▸ POST https://api.yourapp.com/hooks/orders
  x-agentx-signature: t=1720512000,v1=hmac…
  { candidate: { total: 240, items: [...] } }

your code ◂ { transform: { total: 240, taxLine: 21.6 } }
agentx    ▸ re-validate → stamp identity → write

agent ▸ test_hook({ … })   // dry-run, nothing written`,
    facts: ["HMAC-signed, strict timeout", "validate or transform mode", "test_hook dry-run", "hook.* rows in delivery log"],
    boundary: "\"AgentX never hosts tenant code\" is the product boundary, not a missing feature. Hooks gate synchronously; events handle async; computed fields derive; CAS writes back. Full business logic composes on your infrastructure.",
  },
  {
    id: "realtime",
    num: "007",
    title: "Realtime",
    headline: "A change feed that keeps secrets.",
    body: "Every mutation path writes an append-only change feed with write-time visibility capture. Consume it by polling GET /v1/changes (ETag/304) or over SSE with Last-Event-ID resume. Gating is then-AND-now: a change is served only if it passed the rules both when written and right now — visible→hidden becomes a tombstone, never-visible activity is suppressed entirely.",
    mechLabel: "GET /v1/changes/stream · SSE",
    mech: `GET /v1/changes/stream
id: 4821
event: entry.updated
data: { collection: "posts", id: "ent_x92", … }

id: 4822
event: entry.tombstone      // visible → hidden: content withheld
data: { collection: "posts", id: "ent_a17" }`,
    facts: ["written at every mutation path", "then-AND-now privacy gating", "SSE + long-poll degrade", "~2–4s worst-case lag"],
    boundary: "Documented-lossy by design: worst-case lag is 2–4 seconds and sync clients periodically reconcile with a full list GET. We say so, because your sync logic needs to know.",
  },
  {
    id: "trust",
    num: "008",
    title: "Trust",
    headline: "Nothing is lost. Everything is accountable.",
    body: "Deletes go to trash with a 30-day sweep and one-call restore. Every update snapshots a pre-image (20 per entry) with one-click restore — itself undoable. An audit log records every mutation with the actor, from all three surfaces. Purge, empty-trash and schema drops are plan + confirm with inbound-reference and asset disclosure.",
    mechLabel: "purge_entry · plan + confirm",
    mech: `agent ▸ purge_entry({ id: "ent_a17" })
agentx ◂ plan:
  ⚠ 3 inbound relations (orders.product)
  ⚠ 2 assets will lose their last reference
  this is permanent — trash restore will not apply
agent ▸ confirm
agentx ◂ purged · audit row written (actor: mcp:agent)`,
    facts: ["trash, 30-day sweep", "20 versions per entry", "audit on every mutation", "manifest export / import round-trip"],
    boundary: "Version restore runs through full validation and is itself undoable. The safety net has no trapdoors — even recovery actions leave an audit trail.",
  },
];

export function LeafBrowser() {
  const [current, setCurrent] = useState("data-modeling");
  useEffect(() => {
    const sync = () => {
      const id = window.location.hash.slice(1);
      if (LEAVES.some((l) => l.id === id)) setCurrent(id);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const d = LEAVES.find((l) => l.id === current)!;

  return (
    <div className="mx-auto flex max-w-[1280px] flex-wrap items-start">
      <aside
        className="box-border flex max-w-full flex-[1_1_240px] flex-col gap-0.5 py-10 pl-8 pr-0"
        style={{ borderRight: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}` }}
      >
        <Link
          href="/product"
          className="mb-[18px] font-mono text-[11px] tracking-[0.1em]"
          style={{ color: C.faint }}
        >
          ← AGENTX
        </Link>
        {LEAVES.map((l) => {
          const on = l.id === current;
          return (
            <a
              key={l.id}
              href={`#${l.id}`}
              onClick={() => setCurrent(l.id)}
              className="-mr-px flex items-center gap-3 rounded-l-md px-3.5 py-2.5 text-sm"
              style={{
                color: on ? C.accent : C.mute,
                background: on ? "rgba(67,222,131,0.07)" : "transparent",
                borderRight: `2px solid ${on ? C.accent : "transparent"}`,
                fontWeight: on ? 600 : 400,
              }}
            >
              <span className="font-mono text-[10.5px]" style={{ color: C.faint }}>{l.num}</span>
              <span>{l.title}</span>
            </a>
          );
        })}
      </aside>

      <main className="box-border min-h-[70vh] min-w-0 flex-[999_1_min(100%,520px)] px-8 pb-20 pt-14">
        <div key={current} className="flex max-w-[760px] flex-col gap-7" style={{ animation: "leaf-in 0.45s cubic-bezier(0.16,1,0.3,1)" }}>
          <span className="font-mono text-xs tracking-[0.14em]" style={{ color: C.accent }}>
            AGENTX / {d.num}
          </span>
          <h1 className="m-0 text-[clamp(32px,4vw,46px)] font-bold leading-[1.08] tracking-[-0.03em]">
            {d.headline}
          </h1>
          <p className="m-0 text-[16.5px] leading-[1.65]" style={{ color: C.mute }}>{d.body}</p>

          <div className="overflow-hidden rounded-lg" style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.1)` }}>
            <div className="px-4 py-2.5 font-mono text-[11px]" style={{ borderBottom: `1px solid ${C.line}`, color: C.faint }}>
              {d.mechLabel}
            </div>
            <div className="whitespace-pre-wrap p-5 font-mono text-[12.5px] leading-[1.9]" style={{ color: C.mute }}>
              {d.mech}
            </div>
          </div>

          <div className="flex flex-wrap gap-2.5">
            {d.facts.map((f) => (
              <span
                key={f}
                className="rounded-[4px] px-3 py-[7px] font-mono text-[11.5px]"
                style={{ color: C.mute, border: `1px solid rgba(255,255,255,0.12)` }}
              >
                {f}
              </span>
            ))}
          </div>

          <div
            className="flex gap-3.5 rounded-lg px-5 py-[18px]"
            style={{ background: "rgba(67,222,131,0.05)", border: `1px solid rgba(67,222,131,0.2)` }}
          >
            <span className="flex-shrink-0 font-mono text-xs" style={{ color: C.accent }}>honest ▸</span>
            <p className="m-0 text-[13.5px] leading-[1.6]" style={{ color: C.mute }}>{d.boundary}</p>
          </div>

          <div className="mt-2 flex flex-wrap gap-3.5">
            <CTA href="/pricing">Become a beta tester</CTA>
            <CTA href="/developers" variant="ghost">See it in the docs →</CTA>
          </div>
        </div>
      </main>
    </div>
  );
}
