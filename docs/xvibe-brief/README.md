# XVibe — build brief

> Copy this whole folder into the new XVibe project as its first commit.
> Assembled 2026-07-25 from decisions settled in the Pluggie sessions, so the
> XVibe build starts from conclusions instead of re-deriving them.

## Read in this order

| # | File | Why |
|---|---|---|
| 1 | **[CONNECTION.md](CONNECTION.md)** | **The contract.** How XVibe talks to Pluggie: the two surfaces, the JSON-RPC shape, how tokens work today vs after OAuth, the build loop, the boundary rules. Start here. |
| 2 | [XVIBE-PLAN.md](XVIBE-PLAN.md) | The product plan: the static-heads boundary, the phases, what is deliberately out of scope, and the open questions. |
| 3 | [prototype.html](prototype.html) | Working interactive prototype — open it in a browser. Chat → agent builds → live preview → publish. The north-star screen for Phase 1. |
| 4 | [PLUGGIE-CAPABILITIES.md](PLUGGIE-CAPABILITIES.md) | What the backend can do today, by surface. Reference, not required reading. |
| 5 | [PLUGGIE-MCP-CONTRACT.md](PLUGGIE-MCP-CONTRACT.md) | Generated dump of all 60 MCP tools with schemas. Look things up here; **prefer the live surface** (`tools/list`) since this snapshot ages. |

## The one-paragraph version

XVibe is a **client of Pluggie**, not a fork. A user describes an app; a builder
agent (XVibe's own code, server-side) defines the backend over Pluggie's MCP
API and generates a frontend; the built app is a **static bundle on R2/CDN**
that calls Pluggie's delivery API for everything dynamic. XVibe never executes
tenant code and never touches Pluggie's database or source directly.

**Phase 1** is reachable from inside Pluggie — a "Build & deploy" button in a
project — so the session carries and no new signup or provisioning is needed.
**Phase 2** adds a standalone front door. Keep the entry point swappable and
Phase 2 is an addition, not a rebuild.

## You are not blocked on anything

The Pluggie side is mid-flight on scoped tokens (D2) and OAuth (D3). **Neither
blocks Phase 1.** Mint an mcp token by hand today (CONNECTION.md §3a), read it
from one function, and swap to OAuth later as a one-function change.

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
