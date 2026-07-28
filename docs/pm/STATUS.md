# Status — where things stand

> **Updated 2026-07-26.** One page. If you read nothing else, read this.
> Full inventory: **[BOARD.md](BOARD.md)** · process: **[README.md](README.md)**

## Right now

**The MCP connection story is finished and live.** A client connects to
`https://pluggie.app/api/mcp` with a URL and a browser — no token copying. That
was the arc of the last three sprints and it is done, verified end-to-end
against a real Claude Code client on production.

**Current sprint: [Field signal](../plans/SPRINT-FIELD-SIGNAL.md)** — 15 tasks
across 5 tracks, prioritised by *independent confirmation*: five issues that two
or more unrelated testers hit. Nothing started yet.

**Next task if nobody says otherwise: A1** — the `admin` workflow actor silently
includes client-role members. Two reporters, eight days apart, and the only
security-shaped item on the board.

## What just shipped (last 3 days)

| | |
|---|---|
| **OAuth / DX-6** | Connect with a URL. RFC 8414 + 7591 + 9728 + PKCE + 8707. Live and proven: Claude Code self-registered, a human consented, a scoped token was issued and used 2 seconds later. |
| **Scoped tokens / MT-1** | Six scopes, enforced at one choke point. Legacy tokens grandfather as full access. |
| **Token expiry** | `expires_at` enforced in `resolveToken` — OAuth tokens expire; console tokens still do not. |
| **Schema drift closed** | Two D1 columns existed in both DBs but not in `db/schema.ts`; a fresh bootstrap would have silently omitted them. |
| **Feedback wall reconciled** | Read 20 open when 18 were already fixed. Now every row carries a receipt. |
| **XVibe handed off** | `docs/xvibe-brief/` — plan, connection contract, setup, design relationship, working prototype. Building in its own session. |
| **Cron retry** | Deploy windows no longer fire false alarms. |

## Blocked on you ⚑

| | Why it matters |
|---|---|
| **Verify `dinodigi.com` SPF/DKIM** | Stallion's notification emails have been dead since 2026-07-15. Also unblocks the EE send proof. Oldest open item with a real client behind it. |
| **Clerk dev → production** | Platform + 11 tenant projects run on dev instances. $0 to fix; needs DNS. **Do it after the domain decision, not before.** |
| **Domain / trademark call** | 4 code files + config today. Much worse after launch or after Clerk production. |
| **3 design calls** (D1/D2/D3) | Gate Track D: `auth_kit` credentials, workflow preconditions, browser-safe delivery token. |
| **2 manual confirmations** | The provider-switch button (never clicked in a browser); the cron Runs tab after a deploy. |

## Health

- **Production:** healthy. OAuth live. 60 MCP tools.
- **Tests:** 655/656 on the last full gate. The one failure is a rate-limit test
  that only fails under full-suite load and passes 5/5 isolated — the limiter is
  fail-open by design, so a slow control DB means no 429 arrives.
- **Feedback wall:** 32 open (15 new from 07-26, 17 carried). See BOARD.
- **Unpushed:** none.

## Watch list — real risks, not scheduled

- **Concurrency is unproven.** CAS, `SKIP LOCKED`, schedule ticks are all
  race-shaped and smoke tests do not find those. Two timing flakes have already
  surfaced (`89-schedule`, the rate limiter).
- **The cache is fighting the product.** Three independent signals now — a field
  report, an outside architecture review, and our own repeated carve-outs.
  Measure a 2s TTL before adding a fourth exception.
- **Single-source validation, improving.** Was one agent on one host; now Codex,
  jabed, and XVibe are all reporting. Keep it that way.

## Definition of done here

Ship = built **+** tested **+** deployed **+** the wall row dispositioned with a
receipt. Skipping the last step is what made the wall lie for a week.
