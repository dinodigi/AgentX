# Status — where things stand

> **Updated 2026-07-31 (CONTRACT-1 shipped).** One page. If you read nothing else, read this.
> Completion list: **[QUEUE.md](QUEUE.md)** · full inventory + receipt ledger:
> **[BOARD.md](BOARD.md)** · protocol: **[BURNDOWN.md](BURNDOWN.md)**

## Right now

**CONTRACT-1 is SHIPPED** (2026-07-31, five checkpoints: `86294e0` `6ba1c83`
`eb98eea` `ddd650b` + doc sync) — the flagship agent-facing language pass, with
DX-1 folded in and WP-6's doc half done. All 61 tool descriptions were diffed
against live behavior. The headline finds were not typos: `list_field_types`
advertised 8 primitives while returning 10, so `group`/`array` had been
invisible to the contract's own audience since DM-1; `capacity` — the booking
primitive — appeared in the payload only inside another field's incompatibility
list; `compute.writeBack` promised delivery-side idempotency that does not
exist, contradicting `briefing.notSupported` in the same response; and a
delivery 413 shipped carrying `E_INTERNAL`, a code documented as "not
agent-repairable", for the most repairable failure on the surface.

The structural half is `get_project_info.answers`: a routing table from the
questions integrators actually ask to the key that answers each. That shape was
chosen because the dogfood upload failure was never "undocumented" — the
endpoint existed and the agent shipped credentials to a browser anyway. More
prose would not have helped; routing does.

**What keeps it from drifting back**: suite 114 (27 tests) plus suite 11, in the
108/110 pattern. Where possible the assertions are DERIVED rather than typed —
the primitive count is compared against what the tool returns, the operator
lists against `WHERE_OPS`, `describe_collection`'s prose against the keys it
really returns, every `answers` pointer against the payload — so an 11th
primitive, a 10th operator or a renamed key fails the build until the words
follow. Every fix was negative-controlled by breaking it and watching its own
test fail; two of those controls found holes in the tests themselves.

Next work, unchanged in priority: **QRY-4** (entry-level import — gates the
operator's dev/prod split), **ENV-1** (staging), **WP-6's code half** (now with
its regression test already written), **CONN-2** (SMS, trigger fired).


**The burn-down finished at 32/32, and the XVibe intake sprint is COMPLETE** —
all five scheduled items from the first field batch shipped same-day with
receipts (registry, publicRead note, transition stamps, define dryRun,
reset_project — plan: plans/SPRINT-XVIBE-INTAKE.md). A second mini-batch
arrived during the sprint: a bug report RETRACTED by its own reporter (closed
as the pair), and an SMS ask that FIRED CONN-2's trigger — the SMS adapter
category is now scheduled work. An open wall item means scheduled work, not
untriaged signal.

```
FEEDBACK WALL   ██████████████████░░  91% by effort  (41/43 · the 2 open ride QRY-4 + CONN-2)
BACKLOG         ████████████████████  100% dispositioned — 16 scheduled · 23 ⏳ · 1 ⚑
```

**Zero repeat themes remain.** Every issue two or more unrelated testers hit is
closed. That was the organising principle of the sprint and it is finished.

**CP10 is done** (2026-07-29): the backlog is 100% dispositioned — 13 scheduled,
22 on-trigger, 1 operator — and `npm run pm` now mechanically verifies receipts
and hunts silent ships. **The whole board reads zero. The burn-down freeze is
over.** Next work is chosen, not owed: CONTRACT-1 is the flagged flagship;
QRY-4 (entry-level import) gates the operator's dev/prod split; ENV-1 is the
next-sprint-sized infrastructure bet.

## The three decisions, all made and all shipped

| | Decision | State |
|---|---|---|
| **D3** | Browser-safe read-only delivery token | ✅ `57bbea4` — XVibe's per-app proxy is deletable |
| **D2** | Workflow transitions gate on the row, not just the actor | ✅ `346cdd4` |
| **D1** | Platform primitives (SEC-1 + `auth_kit` v2), not identity provider | ✅ `4de9ddb` `4e4491f` |

### What D1 turned out to be

`SEC-1` shipped as `{type:"text", writeOnly:true}` — written, never returned by
any read, absent rather than masked. Details in
[CAPABILITIES](../CAPABILITIES.md#1-data-modeling).

**One finding worth carrying forward, because it re-shaped the deliverable:** a
write-only field cannot hold a password hash. Verifying a hash means comparing
it, and a comparison is a read — argon2id embeds a random salt, so you cannot
even recompute the hash without the stored value. So SEC-1 does not by itself
let us hold tenant credentials; that needs platform-side verification, which is
the identity-provider scope D1 declined. `auth_kit` v2 therefore ships the
*recipe* (argon2id parameters, the real-dummy-hash timing defence, atomic
lockout, single-use non-enumerating resets) rather than the mechanism, and
**BACKLOG SEC-3** carries the platform-side option with a trigger. The wall
receipt says all of this in the reporter's own terms.

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
| **Write-only field in the admin form** | The SERVER side is asserted by test — the redacted `initial` prop, so nothing reaches the page payload. The rendering (an empty `type="password"` input, the red `write only` badge, "leave blank to keep") has never been *looked at*: `/admin` is Clerk-gated, so a build session cannot sign in. One glance at any collection carrying a `writeOnly` field settles it |

## The recurring lesson

Three separate boards have gone stale in the same direction: the wall (20 open
when 18 were fixed), the backlog (HIGH items reading "not started" days after
shipping — twice, including during the sprint that fixed the wall), and
BOARD.md's own hand-kept sprint table (13 items open after they shipped).

Every case was a human-typed mirror of machine-known state — and CP10 found a
**fourth** (AUTO-1, DX-5, PLUG-2, all shipped, all reading open). **Anything
derivable is now derived, and what cannot be derived is verified**: the wall
ledger is generated from the DB, and `npm run pm` now cross-examines the
hand-typed backlog against git — cited receipts must resolve, a commit subject
naming a still-open item id raises a warning, and every ⏳ must carry an
observable trigger. The detectors were proven by breaking them on purpose.
