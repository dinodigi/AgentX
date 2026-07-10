# AgentX — Design Brief (platform UI pass + marketing site)

> For the design session. Self-contained: everything you need is in this file
> or at the file paths it names. Two workstreams — **A: marketing pages**
> (net-new) and **B: platform UI polish** (existing product). Deliver specs the
> engineering session can wire directly (formats at the bottom).

## 1. What AgentX is (positioning input)

AgentX is an **MCP-native backend platform**: an AI agent defines a project's
data model over MCP and instantly gets back (1) a **branded admin** the end
client works in, and (2) a **delivery API** the live site consumes. No
per-project backend code. Built by Currents Studio (an agency) — today it runs
their client sites; the trajectory is a multi-tenant platform where users bring
their own infrastructure as connectors (Clerk auth, Resend email, Stripe
payments) and agents do the building.

Capability inventory for marketing copy: [docs/CAPABILITIES.md](CAPABILITIES.md)
— 42 MCP tools, per-field public-read delivery API, authorization presets,
automation (events/schedules/workflows), Stripe checkout, before-write hooks
("your code on your infra — AgentX never hosts tenant code"), near-realtime
change feed, image transforms, per-field i18n, trash/versions safety net.

**Audience for marketing**: agencies and product developers who build client
sites *with AI agents* and are tired of hand-rolling a CMS + admin + API per
project. Secondary: the agency's own clients (they experience the admin, and
the marketing site sets expectations for what they were handed).

**Voice**: confident, technical, concrete. The platform's own design rules are
a good tone reference — "declarative + self-describing", "machine-readable
errors with fix hints", "destructive = plan + confirm". Anti-hype; show real
mechanics (tool calls, plans, diffs) rather than abstract AI promises.

## 2. Design direction — THIS IS A REBRAND

**The owner has decided to move away from the current look.** The incumbent
system ("paper-and-ink editorial": warm paper canvas, ink sidebar, Bricolage
Grotesque display type) is documented below only so you know what you're
replacing and what its wiring contract is. Do not extend it.

**Target direction: futuristic, technical, AI-native.**
**Primary reference: the Payload CMS website (payloadcms.com).** What we like
about it: dark-first, high-contrast, engineered feel — visible grid/hairlines,
monospace accents for technical truth (ids, tool names, code), restrained
near-monochrome palette with one sharp accent, generous negative space,
type-led rather than illustration-led, subtle purposeful motion. It looks like
a serious tool built by people who ship. AgentX's subject matter fits this
perfectly: MCP tool calls, schema diffs, plan+confirm flows ARE the visuals —
lean into rendering real mechanics (terminal-style tool-call snippets, schema
diffs, API responses) as first-class design elements.

Anchor on Payload as the reference point, but this must not read as a Payload
clone — find AgentX's own signature within that genre (one direction, not
three options).

**Scope of the rebrand**: marketing AND the platform admin — one system, two
registers. Dark-first is on the table for the admin too (owner is open to it);
decide and commit. Fonts are replaceable (next/font makes wiring trivial —
pick license-safe/open faces; a strong mono is essential to this direction).

### The incumbent (what you're replacing — wiring contract only)

Lives in [app/globals.css](../app/globals.css). The **class-name contract**
matters for wiring even after the rebrand: ~20 admin pages consume
`.card`, `.btn`, `.btn-primary`, `.btn-ink`, `.field-input`, `.chip-*`,
`.eyebrow`, `.display`, `.section-label`, `.richtext-editor`. Preferred:
keep these class NAMES and restyle their values wholesale (cheapest wiring).
If the new system genuinely needs a different vocabulary, deliver an explicit
old→new mapping and engineering will migrate.

Two hard invariants that survive the rebrand:
- `--brand`: each project injects an arbitrary client brand color into the
  admin at runtime — the new system needs explicit rules for where that color
  appears and how it stays legible on the new (likely dark) surfaces.
- **Stack**: Next.js App Router + Tailwind v4, server components by default.

## 3. Workstream A — marketing pages (net-new)

Nothing exists today. Proposed minimum set (adjust if you see a better shape):

1. **Landing** — hero (what AgentX is in one sentence), how-it-works in 3 beats
   (agent defines schema → branded admin appears → site consumes the API),
   capability grid drawn from CAPABILITIES.md, an honest "built for agents"
   section (MCP tools, self-describing errors, plan+confirm), CTA (today:
   "request access" — the platform isn't self-serve yet; no pricing exists).
2. **Product / capabilities** — deeper page per pillar: data modeling & admin,
   delivery API, automation, payments, compute boundary (hooks), realtime,
   i18n/media. Diagrams welcome (original artwork only).
3. **For clients** — a short page an agency can send THEIR client: "this is
   the admin you'll get" (screens of the branded admin).

Constraints:
- Lives in the same Next app under a `(marketing)` route group (default
  assumption — flag if you'd rather it be standalone).
- Marketing is where the new direction (§2) shows at full strength; the admin
  is its quieter, denser sibling — one recognizable system across both.
- Original illustrations/diagrams only; no stock-alike AI hero clichés
  (no glowing brains, no robot hands). Real mechanics as visuals: tool-call
  transcripts, schema diffs, plan/confirm exchanges, API payloads.
- Responsive down to 375px; static/server-rendered; no heavy JS libraries.
  Motion via CSS/small hand-rolled JS only.

## 4. Workstream B — platform UI pass (existing, never had a design pass)

The admin is a **client handoff artifact** — an agency hands it to their
client, so it must read as a polished product, not an internal tool. It has
never had a dedicated visual pass (roadmap item C5). Mobile and the TipTap
richtext editor are called out as the weakest spots.

Surfaces (all under [app/admin/](../app/admin/) + [components/](../components/)):

| Surface | Files | Notes |
|---|---|---|
| Studio home (project list) | app/admin/page.tsx | project cards, connector health dots |
| Collection entry list | app/admin/[projectId]/[collection]/page.tsx | auto-generated table, quick search, CSV/JSON export, inbox "handled" affordance, pagination |
| Entry form | components/EntryForm.tsx, [entryId]/page.tsx, new/page.tsx | one input per field primitive; visibility pills (public/admin-only); locale switcher pills + "n/N translated" chips (NEW, never eyeballed); workflow-narrowed selects; read-only computed fields; TipTap richtext (components/RichtextInput.tsx); relation combobox; version-history + audit aside panel |
| Trash | .../trash | restore/purge with arm-to-confirm buttons |
| Media | .../assets | asset grid |
| Settings | .../settings | tokens, webhooks + delivery log (multi-shape: email/hook/stripe rows), members, manifest import/export, Automation (schedules pause/resume, jobs cancel) |
| Connectors | .../connectors | Clerk/Resend/Stripe cards: health dots, connect/rotate/disconnect, Stripe "provision webhook" |
| Appearance | .../appearance | branding (name/logo/color) |
| API reference | .../api | generated per-project docs |

Design goals, in priority order:
1. **Reskin to the new system (§2)**: this is not a polish pass on the old
   look — every surface moves to the new direction. The entry list + entry
   form are what clients live in; they should feel like a paid product.
   Keep the "teaching" empty states, raise the craft.
2. **Mobile**: sidebar is a drawer; forms and tables need real small-screen
   treatment, not just wrapping.
3. **Brand-color resilience**: every accent must survive an arbitrary client
   `--brand` value (including ugly ones) on the new surfaces — define usage
   rules (where brand color may/may not appear, contrast fallbacks). This
   gets HARDER on dark surfaces; solve it explicitly.
4. **The operator surfaces** (settings/connectors/automation) can be denser
   and more technical — the register where the mono/terminal voice of the
   new direction is most at home.

What NOT to change: form semantics and field behavior (inputs, hidden fields
like `__locale`, confirm-flows); information architecture of settings; any
functional class hooks. Visual/spacing/typography/state changes are all fair
game.

## 5. Deliverables (what engineering needs back)

1. **Direction**: one consolidated visual direction (not three options),
   Payload-anchored per §2 — moodboard + a FULL new token sheet (palette,
   type scale + chosen faces, spacing, radii, borders/hairlines, shadows,
   motion rules). Explicit decisions to make and state: dark-first for the
   admin yes/no; how `--brand` client colors behave on the new surfaces.
2. **Marketing pages**: high-fidelity mockups (HTML/Tailwind v4 preferred —
   they wire near-verbatim; Figma acceptable with a full handoff spec), all
   breakpoints for the landing page, copy included (or marked TODO-copy per
   block).
3. **Admin pass**: annotated redlines per surface in the table above —
   updated `globals.css` tokens/classes + before/after specs. Component-level
   states for: buttons (idle/hover/pending/armed-confirm), chips, table rows
   (+ unhandled badge), form fields (idle/error), empty states, TipTap
   toolbar, locale/visibility pills.
4. **Assets**: original SVG illustrations/diagrams for marketing, favicon/og
   treatment.

Format notes for the wiring session: Tailwind v4 utilities + the shared class
vocabulary (or an explicit old→new class mapping, see §2); new fonts fine via
next/font (state the faces + licenses); no new runtime deps without flagging;
every spec names the file it applies to.

## 6. Open questions (answer or decide-and-note)

1. Marketing CTA reality: "request access" vs "book a call" vs just a repo
   link — owner call (platform is not self-serve until Phase 20).
2. Product name/logo: "AgentX" is the working name — is it the shipping name?
   Marketing pages make this decision real; the rebrand is the moment to
   settle it.
3. Same-app `(marketing)` route group vs separate site (default: same app).
4. Screenshots of the current admin for workstream B: the admin is auth-gated;
   ask the owner for a walkthrough/screens, or design from the component
   files listed above.
5. Admin dark-first: owner is open to it (Payload's own admin is dark-capable)
   — design should make the call and defend it, considering client-facing
   readability and the `--brand` injection.
