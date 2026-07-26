# Sprint — XVibe: the studio on top of Pluggie

> Initiative plan — written 2026-07-25. Status marks inline (⬜ / 🚧 / ✅).
> ⚑ = needs the operator.
>
> **This supersedes the 2026-07-20 park decision** ("XVibe is a LATER product,
> not anytime soon — don't re-pitch"). Revived by the operator 2026-07-24:
> *"we can have ownership from end to end… pluggie as backend and xvibe as
> development IDE and hosting… we can have a big loop and be able to evolve our
> platform faster."* Promoted to its own sprint 2026-07-25 — it is too large to
> ride along in another plan.
>
> **Nothing is built.** A working prototype exists as a published artifact
> (chat → agent builds → live preview → publish). This plan captures decisions
> that currently live only in conversation.

## Why now (what changed since the park)

When XVibe was parked, its core mechanism — *a builder agent connects to a
fresh project and builds unattended* — was hand-waving. Two sprints since have
made it concrete without anyone framing it as XVibe work:

- **TOK-1** (shipped): programmatic credential issuance. The agent can mint the
  delivery token the generated client needs, with parentage + cascade revoke.
- **The friction sprint** (shipped): agents read their own writes, learn when
  the platform changes under them, and get diagnostics instead of dead ends.
- **D3/OAuth** (planned, not built): connect-with-a-URL.

XVibe's connection story *is* the friction sprint's finish line. That is the
argument for finishing the spine before building the studio — not sequencing
for its own sake.

**Strategic payload:** today the platform improves because the operator builds
on it and triages. XVibe makes every user a live dogfood session — agent hits
friction → `send_feedback` → wall → fixed once → every future build improves.
It converts a manual, single-source feedback loop (currently one agent on one
host) into a continuous, self-generated one.

## The boundary (first principle — do not drift)

**Static heads only. Pluggie never executes tenant code.**

- XVibe serves **built files** from R2 + CDN. The app's own logic runs in the
  **visitor's browser**. Cost is pennies per app; a malicious bundle is
  sandboxed in the visitor's browser and can never touch our infrastructure.
- The backend is **Pluggie's delivery API** — which we already operate. That is
  the unfair advantage: static-frontend-plus-Pluggie feels full-stack while
  running zero tenant code. Bolt/Lovable-class competitors punt on the backend;
  we own it.
- **Executing tenant code = a second infrastructure business** (sandboxing,
  build pipelines, orchestration, resource limits, abuse response). Explicitly
  rejected for Phase 1–2. See Phase 3 for the one bounded exception.

**What we actually build** (small, adjacent to existing competence): the IDE
front end (itself a static app), the builder-agent orchestration (an MCP client
of our own surface), and a deploy control plane (push to R2, trigger builds).
**What we rent or already run** (all the hard parts): Pluggie, Cloudflare
(CDN/R2/Workers), Neon, the Claude API. We operate a control plane, never a
runtime.

## Phase 0 — Prerequisite (not XVibe work)

- ⬜ **D3/OAuth ships** ([MCP-FRICTION-PLAN.md](MCP-FRICTION-PLAN.md) Track D).
  The builder agent must connect without a human copying tokens. Gated in turn
  on D2's scope vocabulary — ⚑ operator sign-off outstanding.

## Phase 1 — The button (the cheap, correct first cut)

Operator's model, 2026-07-25: *"they would start with pluggie as normal… when
they go into a project they will also find a button to build and deploy. Once
they click it, that's when they access xvibe."*

This is the least-work version and it is not a compromise — three hard problems
vanish:

- **Single sign-in is free.** Entering XVibe from inside Pluggie carries the
  session. No separate accounts, no SSO plumbing.
- **No programmatic project provisioning.** The project already exists; the
  button opens XVibe pointed at it. (That API is Phase 2's problem.)
- **Warm audience.** "You built a backend — now ship a frontend in one click"
  is an expansion moment, not a cold-acquisition problem.

- ⬜ **P1.1 — "Build & deploy" entry point** in the project admin.
- ⬜ **P1.2 — the IDE**: chat + code editor + live preview (prototype exists).
- ⬜ **P1.3 — builder-agent orchestration**: Claude API + MCP client of the
  current project; generates the frontend and calls `get_client_code`.
- ⬜ **P1.4 — deploy control plane**: build → static bundle → R2 → CDN purge →
  live at `<app>.xvibe.app`.
- ⬜ **P1.5 — ⚑ `xvibe.app` DNS + a wildcard `*.xvibe.app` cert.**

⚠️ **Design rule, load-bearing: keep the entry point SWAPPABLE.** Do not
hardcode "the project always already exists." Phase 1 is door #1; Phase 2 adds
door #2 to the same room. Violating this turns Phase 2 into a rebuild.

## Phase 2 — The standalone front door

The Bolt/Lovable market is the *opposite* person: someone who would never sign
up for a thing called "backend platform" and just wants to type "build me an
app." Same IDE, same agent, same pipeline — different entry.

- ⬜ **P2.1 — XVibe accounts** (its own audience, separate from Pluggie
  operators).
- ⬜ **P2.2 — programmatic project lifecycle**: create a project in a user's
  workspace + provision its DB + issue a scoped token; delete an app → delete
  the project (the FK cascades already wipe the data — verified on Hatchly
  2026-07-24).
- ⬜ **P2.3 — plain-language capability mapping**: users see "logins", "a
  booking form", "emails"; the agent composes `auth_kit` / `booking` /
  notification plugins. **Pluggie's features are not decoupled or rebuilt** —
  the plugin system already IS the composable library; XVibe re-presents it.
- ⬜ **P2.4 — UGC on `xvibe.app`** keeps `pluggie.app` reputation clean
  (original 07-20 architecture note, still right).

## Phase 3 — Custom logic, bounded (the one code-execution exception)

Static + Pluggie covers most apps. The remainder needs bespoke server logic.

- ⬜ **P3.1 — Cloudflare Workers as the rented runtime.** V8 isolates:
  sandboxing is *already solved by Cloudflare*, no filesystem, no arbitrary
  processes. We deploy via their API and meter it. We never own the sandbox.
- 🛑 **Gates before this ships — non-negotiable.** The moment tenant code runs
  in our name, three burdens attach permanently and renting compute does not
  rent us out of them:
  1. **Abuse** — a phishing page or miner on `*.xvibe.app` is our domain's
     reputation and our legal exposure. Needs detection + a response process.
  2. **Cost control** — idle apps and infinite loops cost money. Hard limits
     and billing enforcement *before* launch, not after the first surprise bill.
  3. **Support** — "my app won't deploy" becomes an inbox we do not staff today.

## Open questions (⚑ operator)

- **Pricing/positioning.** The 07-24 outside review flagged a mismatch already
  present in Pluggie ($19/$29 reads indie; org scoping + RBAC + audit trails
  read mid-market). XVibe forces the question rather than resolving it.
- **Naming/brand relationship** — how loudly is "runs on Pluggie" said?
- **Does XVibe compete with the agency work?** The strongest current wedge is
  *the backend for agencies who build with agents*. XVibe partly disintermediates
  that. Deliberate call, not an accident to stumble into.

## Risks

- **Scope.** This is a second product. The operator named the real risk
  themselves on 07-24 ("I'm personally a bit lost") while four loops were open.
  Phase 1 only after the spine lands.
- **The seam.** "What happens when Pluggie isn't enough" decides whether
  static-heads holds or quietly drifts into becoming Replit. Phase 3's gates
  are that seam, written down.
- **Single-source validation.** Everything we know about agent friction comes
  from one agent on one host. XVibe fixes this — and is also exposed to it.

## Reference

- Working prototype (published artifact, 2026-07-25) — chat → build → preview →
  publish, with the Pluggie/Neon/R2 stack surfaced in the chrome.
- Architecture discussion: static-vs-execute breakdown, Path C mapping, and the
  XVibe↔Pluggie concept mapping (account=workspace, app=project+DB,
  builder=MCP client, features=plugins).
