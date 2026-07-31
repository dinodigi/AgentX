# The completion list — every item, and what happened to it

> **Living — last synced 2026-07-30.** Protocol: [BURNDOWN.md](BURNDOWN.md) ·
> decisions: [DECISIONS-CP9.md](DECISIONS-CP9.md)
>
> Run `npm run pm` for live counts and the **receipt ledger** in
> [BOARD.md](BOARD.md) — that shows every closed item with its commit hash or
> reopening trigger, generated from the same rows the reporter reads.

## Where the burn-down stands

```
FEEDBACK WALL   █████████████████░░░  83% by effort — burn-down met at 100%,
                then POST-FREEZE INTAKE arrived (by design, the wall never closes)
                34/40 items closed (85% by count) · 101/122 effort points
BACKLOG         ████████████████████  100% dispositioned — 16 scheduled · 23 ⏳ · 1 ⚑
```

**Zero repeat themes remain.** Every issue two or more independent testers
reported is closed. That counter hit 0 at CP4.

**Post-freeze intake, 2026-07-30 (xvibe, 8 items):** triaged same-day with the
operator — 2 closed with receipts (`15e5783b` ANSWERED with the DX-2 build,
`6e5af8cd` split TRIGGER/decline), 6 set `planned` with reporter-visible notes
naming their backlog ids (WF-1, WP-9, DX-7, OPS-6, CONTRACT-1's registry, and
QRY-4's branching absorption). Open-wall = scheduled work now, not un-triaged
signal.

---

## ✅ Done

| CP | What | Commit |
|---|---|---|
| **CP1** | Burn-down protocol + a checkpoint gate that runs in 60s, not 25min. Closed 6 items already fixed but still reading `new` | `7aed86d` `0dbf3ff` |
| **CP2** | 6 papercuts: `startingFrom` (atomic first increment), `id` in where, bulk shape unwrap, null-as-absent in blocks, `neOrUnset` | `0dbf3ff` |
| **CP3** | Both open bugs: stale probe verdicts reported as live faults; `get_client_code` omitting claim-write mutators | `65fa439` |
| **CP4** | `indexed` on date fields — raw-text index proven exact, EXPLAIN-asserted | `2dfa814` |
| **CP5** | `publicWrite` + `access.write` **compose** — anonymous intake alongside gated triage | `8d63719` |
| **CP6** | `addFields` (with a real CAS), bulk cap 100→500, enum option renames | `f5a99f7` `260e64b` |
| **CP7** | The scaling traps: array membership filtering, relative time in `publicFilter`, date buckets + 2nd `groupBy` | `47ed83e` `279d70e` `0ee45c9` |
| **CP8** | `capacity: N` as a database guarantee (per-key advisory lock); 2 items closed as ⏳ TRIGGER | `bea3377` |
| **—** | Delivery status codes say which question each answered | `43d0cd9` |
| **—** | Host migration notice — built now, silent until the new domain exists | `1833cd3` |
| **D3** | Browser-safe **read-only** delivery token — XVibe's per-app proxy is deletable | `57bbea4` |
| **D2** | Workflow transitions gate on the **row**, not just the actor | `346cdd4` |
| **D1** | **SEC-1 write-only fields** — written, never returned by any read, on all five surfaces plus webhooks, hooks and the admin. Absent rather than masked, in two layers, with a test per surface that fails when its own redaction is removed (verified by breaking four of them) | `4de9ddb` |
| **D1** | **`auth_kit` v2** — the credential *recipe*: atomic lockout, single-use non-enumerating resets, argon2id parameters, and the real-dummy-hash trap. Verification stays with the tenant, because a comparison is a read → BACKLOG **SEC-3** carries the platform-side option with a trigger | `4e4491f` |

**The wall is now at 0 open — 32/32, 99/99 effort points.**

## ✅ CP10 · Backlog sweep — DONE 2026-07-29

All 41 open rows dispositioned; `npm run pm` reports **100% dispositioned — 13
scheduled · 22 ⏳ trigger · 1 ⚑ operator** (plus 20 ✅ with verified receipts).
🅿️ Parked is retired. The sweep found the staleness it predicted, a **fourth**
time: AUTO-1 and DX-5 read "not started" though shipped (`9bc9988`, `66ad28e`),
and PLUG-2 read "in progress" with all four Phase-1 tracks landed.

Executed inline as the ANSWER batch (copy merged + contract tests, suite 108):
**WP-3** (hooks×bulk contradiction — the description now tells the per-item
truth), **WP-4** (same-state semantics: no-op on `update_entry`, deliberate
E_CONFLICT on the CAS path, with the single-fire reason), **QRY-3** (rate + size
budgets published in `get_project_info.deliveryApi.limits`, pinned to the wire
by tests that actually hit the 429 and the 413).

**"Shipped-state derived from commits" landed as verification, not generation:**
`npm run pm` now checks every cited hash exists (`git cat-file`), greps commit
SUBJECTS for still-open item ids (the silent-ship detector — it catches the
AUTO-1 case mechanically; docs-only commits filtered), and enforces the
disposition shape (every ⏳ carries an observable `TRIGGER:`). Both detector
halves were negative-controlled — regressing AUTO-1 and fabricating a receipt
each produced the warning. The first control run also caught the parser
skipping every `| — |`-priority row (em-dash vs hyphen), which had hidden 14 of
the 20 shipped rows from the receipt check.

### ⚑ Operator-blocked (not mine to close)

| Item | Why it's stuck |
|---|---|
| `dinodigi.com` SPF/DKIM | Stallion's notification emails dead since 07-15; also blocks the Elastic Email send proof |
| Clerk dev → production | Platform + 11 tenant projects on dev instances; $0, needs DNS |
| Domain switch | Decided (`plugster.dev`); mechanics recorded in OPS-5, execution is yours |
| Provider-switch button · cron Runs tab | Never clicked in a browser |

---

<!-- SIZES
16d745d3 S   2bdec2b0 S   2684fec0 L   8570cb24 M   73a14ef7 M   de626cb6 S
1c10d760 S   42a6d515 S   0a5ce08c L   66d1cbd9 S   9c2333cb M   e0b6eb32 M
eff3e105 L   0ceec805 L   a1fb8001 M   34acd74d S   cbf4db8f L   6809681c M
a61039c4 M   75f9f4f7 S   e9628701 M   9c61bc7a S   95b660d1 M   74e7016d S
d128f35a M   ad690ade M   4fae3449 M   5e8146d8 S   1a24b96b M   4847bc14 M
58aaca1e M   921f9ec7 M
0cd6dce5 M   21f4c5d5 S   61f9b82e M   ad7568ba M   2479b787 M   d42e248b L
15e5783b S   6e5af8cd S
-->

**Effort sizes** above are parsed by `npm run pm`. `(S)`=1 `(M)`=3 `(L)`=8. A
raw item count flatters us — the cheap items were batched first on purpose — so
**quote the effort number**. An untagged open item counts as `(M)`, never zero. A
duplicate report of a fix already counted is `(S)`, since it closes on the same
commit.

## Done means

`npm run pm` reports **0 open**, and every 🚫 / ⏳ has its reason or trigger
written into the wall reply where the reporter can read it.

**✅ Met for the wall, 2026-07-29.** The one split disposition (`0ceec805`:
shipped in part, plus a TRIGGER for platform-side credential verification) states
both halves in the reporter's own terms — including the reason the half we
declined cannot be reached from the half we shipped. The backlog half of the
burn-down is CP10.
