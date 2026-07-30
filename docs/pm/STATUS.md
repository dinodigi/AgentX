# Status — where things stand

> **Updated 2026-07-29.** One page. If you read nothing else, read this.
> Completion list: **[QUEUE.md](QUEUE.md)** · full inventory + receipt ledger:
> **[BOARD.md](BOARD.md)** · protocol: **[BURNDOWN.md](BURNDOWN.md)**

## Right now

**The feedback wall is nearly clear.** 31 of 32 items closed, each with a receipt
the reporter can read — a commit hash, or a named condition that reopens it.

```
FEEDBACK WALL   ██████████████████░░  92% by effort  (31/32 items)
BACKLOG         ░░░░░░░░░░░░░░░░░░░░  41 items — CP10, not yet triaged
```

**Zero repeat themes remain.** Every issue two or more unrelated testers hit is
closed. That was the organising principle of the sprint and it is finished.

**Next: CP10**, the 41-item backlog sweep (driveable without the operator), then
**D1** — the last wall item, scoped as SEC-1 (a write-only field type) plus a
hardened `auth_kit` v2.

## The three decisions, all made

| | Decision | State |
|---|---|---|
| **D3** | Browser-safe read-only delivery token | ✅ `57bbea4` — XVibe's per-app proxy is deletable |
| **D2** | Workflow transitions gate on the row, not just the actor | ✅ `346cdd4` |
| **D1** | Platform primitives (SEC-1 + `auth_kit` v2), not identity provider | ⬜ next after CP10 |

## Domain

**Decided: `plugster.dev`** — exact brand match, right signal for a
developer/agency audience, pairs with `xvibe.app`. The $10K `plugster.com` was
declined pre-revenue: a parked `.com` carries no competitor and no trademark, and
the typo leak is identical under any TLD since people type `.com` regardless.

| Domain | Role |
|---|---|
| `plugster.dev` | Plugster platform |
| `api.plugster.dev` | Delivery + MCP API |
| `xvibe.app` | XVibe **studio** — control plane only |
| `*.myxvibe.com` | Deployed tenant apps — isolation boundary + **PSL entry** |

The migration machinery is already built and dormant: set `SUCCESSOR_API_BASE`
and every delivery response gains RFC 8594 headers while `get_project_info`
gains a `migration` note. Nothing breaks — the old host keeps answering, and
`pluggie.app` never has to be retired. Mechanics in **OPS-5**
([BACKLOG.md](../BACKLOG.md)).

## How work runs

**`npm run checkpoint`** — 60s gate: types → `next build` → the smoke files you
name. Refuses to build while a dev server is listening. **Never pipe it into
`tail` before `&&`** — the shell reports tail's exit code, so a failed gate reads
as success. That has bitten twice.

**`npm run verify`** — full 97-file suite, ~25min, once per session.

**`npm run pm`** — refreshes BOARD.md from the live database and prints progress
two ways. Quote the **effort** number; the count flatters us, because the cheap
items were batched first on purpose.

## What needs you ⚑

| Item | Why it's stuck |
|---|---|
| `dinodigi.com` SPF/DKIM | Stallion's emails dead since 07-15; also blocks the Elastic Email send proof |
| Clerk dev → production | Platform + 11 tenant projects on dev instances; $0, needs DNS |
| Buy `plugster.dev` + `myxvibe.com` | Decided. Start the PSL submission for `myxvibe.com` on purchase — free, but weeks to propagate, and it is what enforces the cookie boundary between tenant apps |
| Provider-switch button · cron Runs tab | Never clicked in a browser |

## The recurring lesson

Three separate boards have gone stale in the same direction: the wall (20 open
when 18 were fixed), the backlog (HIGH items reading "not started" days after
shipping — twice, including during the sprint that fixed the wall), and
BOARD.md's own hand-kept sprint table (13 items open after they shipped).

Every case was a human-typed mirror of machine-known state. **Anything derivable
from the database is now derived from it** — the wall ledger is generated, and
finishing that job for the backlog is part of CP10.
