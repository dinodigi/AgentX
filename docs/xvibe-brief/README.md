# XVibe — build brief

> Copy this whole folder into the new XVibe project as its first commit.
> Assembled 2026-07-25 from decisions settled in the Pluggie sessions, so the
> XVibe build starts from conclusions instead of re-deriving them.

## Read in this order

| # | File | Why |
|---|---|---|
| 0 | **[SETUP.md](SETUP.md)** | **Do this first — ~3 min, operator only.** Create the `XVibe Dev` project, mint the mcp token, and run the six calls that prove the integration end-to-end. |
| 1 | **[CONNECTION.md](CONNECTION.md)** | **The contract.** The two surfaces, the JSON-RPC shape, tokens today vs after OAuth, the build loop, **where business logic goes (§8)**, **provisioning (§9 — XVibe cannot create projects)**, **sign-in across domains (§10)**, and the boundary rules. |
| 2 | [XVIBE-PLAN.md](XVIBE-PLAN.md) | The product plan: the static-heads boundary, the phases, what is deliberately out of scope, and the open questions. |
| 3 | [prototype.html](prototype.html) | Working interactive prototype — open it in a browser. Chat → agent builds → live preview → publish. The north-star screen for Phase 1. |
| 4 | [DESIGN-RELATIONSHIP.md](DESIGN-RELATIONSHIP.md) | How XVibe should look *relative to* Pluggie — siblings, not twins — and why the studio and the apps it builds must look different. |
| 5 | [PLUGGIE-DESIGN-BRIEF.md](PLUGGIE-DESIGN-BRIEF.md) | The house style (futuristic/technical rebrand, 2026-07-10). Read §2 for direction. |
| 6 | [PLUGGIE-CAPABILITIES.md](PLUGGIE-CAPABILITIES.md) | What the backend can do today, by surface. Reference, not required reading. |
| 7 | [PLUGGIE-MCP-CONTRACT.md](PLUGGIE-MCP-CONTRACT.md) | Generated dump of all 60 MCP tools with schemas. Look things up here; **prefer the live surface** (`tools/list`) since this snapshot ages. |

## The one-paragraph version

XVibe is a **client of Pluggie**, not a fork. A user describes an app; a builder
agent (XVibe's own code, server-side) defines the backend over Pluggie's MCP
API and generates a frontend; the built app is a **static bundle on R2/CDN**
that calls Pluggie's delivery API for everything dynamic. XVibe never executes
tenant code and never touches Pluggie's database or source directly.

**Phase 1** is reachable from inside Pluggie — a "Build & deploy" button in a
project — so no new signup and no provisioning are needed. (Sign-in carries
only if the studio is served on a `pluggie.app` subdomain; a different domain
needs its own answer — CONNECTION.md §10.) **Phase 2** adds a standalone front
door. Keep the entry point swappable and Phase 2 is an addition, not a rebuild.

## You are not blocked on anything

The Pluggie side is mid-flight on scoped tokens (D2) and OAuth (D3). **Neither
blocks Phase 1.** Mint an mcp token by hand today (CONNECTION.md §3a), read it
from one function, and swap to OAuth later as a one-function change.

## Three things that are NOT what you might assume

1. **XVibe cannot create Pluggie projects.** No API, no MCP tool — project
   creation is a Clerk-gated server action today. Phase 1 works *inside a
   project the user already made*. Building the provisioning API is Phase 2
   Pluggie-side work. (CONNECTION.md §10)
2. **A Pluggie sign-in does NOT carry to `xvibe.app`.** Clerk cookies are
   domain-scoped. Phase 1's cheap answer is to serve the studio on a
   `pluggie.app` subdomain; `xvibe.app` with its own accounts is Phase 2.
   (CONNECTION.md §10)
3. **One XVibe app = one Pluggie project = a billing consequence** past the
   single free sandbox per workspace. Out of scope today (no real users), but
   it shapes Phase 2.
4. **Business logic does NOT go in the frontend.** Pluggie already runs a great
   deal of it declaratively (workflows, access rules, computed fields, events,
   scheduled mutations). A rule in the browser is a suggestion — anyone can
   bypass it. And unlike a Pluggie tenant, an XVibe user has **no server** to
   overflow into, so an inexpressible rule has nowhere safe to land: say so and
   `send_feedback` rather than quietly implementing it client-side.
   (CONNECTION.md §8)

## Ground rules worth memorising

1. **HTTP/MCP only** — never import Pluggie source, never touch its database.
2. **The mcp token stays server-side.** The delivery token goes in the built
   app's server env — never a `NEXT_PUBLIC_*` var, never a client bundle.
3. **Regenerate `get_client_code` after every schema change**, then run
   `verifyConnection()`.
4. **`send_feedback` when the platform gets in your way** — that is the loop
   this whole product exists to close.

## What lives where

- **This folder** is a snapshot. The living originals are in the Pluggie repo
  (`docs/plans/XVIBE-PLAN.md`, `docs/CAPABILITIES.md`, `docs/ai-contract.md`);
  regenerate the contract with `scripts/dump-contract.ts`.
- **Phase 1's "Build & deploy" button** is a small change in the *Pluggie* repo,
  not here — a handful of lines, added when the IDE is ready to receive it.
