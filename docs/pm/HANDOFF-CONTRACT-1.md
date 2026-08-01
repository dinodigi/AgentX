# Handoff — CONTRACT-1: the agent-facing language pass

> **Durable**, written 2026-07-30 at the end of the XVibe-intake session.
> Paste the prompt at the bottom into a fresh session.
>
> **✅ EXECUTED 2026-07-31.** CONTRACT-1 shipped in five checkpoints
> (`86294e0` `6ba1c83` `eb98eea` `ddd650b` + doc sync); DX-1 closed with it
> (search shipped, idempotency answered — it inherits WP-1's trigger); WP-6's
> doc half done, code half still open. Receipts in
> [../BACKLOG.md](../BACKLOG.md); summary in [STATUS.md](STATUS.md).
> **Every one of the eight traps below fired again** — in particular #1
> (negative controls caught two vacuous tests of my own) and #2 (a claim about
> trashed rows freeing capacity was written before it was verified, then
> checked and pinned). Kept as a record of the method, not as live work.

## Why this is a fresh-session task

For the AI-integrator audience the tool descriptions + `get_project_info` ARE
the product — agents plan against them and **believe them over the code**. This
pass audits all 61 tool descriptions, the orientation blob, the error copy, and
the generated client against live behavior. It is the worst possible task to
run on a summarized context full of pre-sprint versions of the exact files it
audits: it wants clean reads and a full budget. (Precedent: D1 was handed off
the same way and the handoff's traps caught real bugs.)

## The task

**The spec lives in [../BACKLOG.md](../BACKLOG.md), CONTRACT-1 detail section** —
scope, the six principles (accurate / complete / discoverable / self-correcting /
boundary-honest / self-contained), and the method. Do not re-derive it.

**Already done — do NOT redo, but USE as the pattern:**
- WP-3 (hooks×bulk lie), WP-4 (same-state semantics), QRY-3 (published budgets)
  — fixed in CP10, pinned by suite 108.
- The `notSupported` registry (`briefing.notSupported`, suite 110 — self-checks
  against BACKLOG shipped rows).
- DX-2: `/api/contract` + `/api/docs/hooks` render LIVE from `TOOL_DEFS`
  (suite 109 pins the pre-CP5 stale phrase out of existence). DX-5's
  statelessTransport docs shipped earlier (`66ad28e`).

**Still in scope:**
1. The systematic behavior-vs-description diff, tool by tool (61), plus
   `get_project_info`'s `deliveryApi.*`/`compute.*` blobs and
   `list_field_types`/`COMMON_FIELD_CONFIG`.
2. Error-copy audit: every refusal names the fix (strong in places; make it
   universal). `E_*` code coverage vs `lib/error-codes.ts`.
3. The structural rethink of `get_project_info` — organize around the questions
   agents actually ask (the BACKLOG detail lists them).
4. **DX-1 (folded in, but it is CODE not copy):** generated client gains
   search + idempotency-key support.
5. **WP-6 doc half only:** document event-webhook signing in the contract. The
   fail-closed CODE change is a separate 📥 row — do not scope-creep into it.
6. Each fix lands with a contract test (suites 108–110 are the model): read the
   live contract the way an agent does, assert the corrected words, and where
   the claim is behavioral, pin it to the wire.

## What this session learned the hard way — every one of these fired

1. **Negative-control every absence/refusal test** (memory:
   `negative-control-tests`). Suite 107's schedule tests passed for a full day
   on a broken recurrence grammar, not on the gates they named; a hash-check
   control itself no-opped silently (assert-less replace). Break the thing,
   watch the test fail, restore. Assert the refusal REASON, never just `ok:false`.
2. **Verify every claim against code before publishing it.** Two near-misses in
   one session: an invented `E_TOO_LARGE` code (the real 413 carries none), and
   a wrong explanation for CAS same-state E_CONFLICT (the real reason is the
   single-fire guarantee — read `updateEntryIfCore` before describing it).
3. **The zod layer silently STRIPS unknown keys.** The D2 `when` clause
   vanished this way once; `transitions[].set` got a describe-round-trip
   positive control for exactly this. Any new input key needs one.
4. **Prose lives in TWO places per tool** — the description string AND the JSON
   `inputSchema` property descriptions. The ai-contract.md rendering is a third
   copy of the same source; regenerate, never hand-edit.
5. **Contract changes break old tests written for narrower contracts.** The
   WP-9 accessNote failed a 22-authz assertion that predated it ("no accessNote
   at all" — its fixture was exactly the new note's trap). Run the FULL verify
   before the last push; targeted sweeps missed it.
6. **Gate quirk:** `npm run checkpoint` refuses on ANY listening dev port —
   including other repos' servers (Hatchly on :3000). Identify the PID first;
   if it is not this repo, run `npx tsc --noEmit` + `npx next build` directly.
7. **wall-resolve seam bug, hit three times:** new RESOLUTIONS entries go
   INSIDE the object literal — pasting above `const stamp` lands them after the
   closing `};`. `node --check` before running.
8. **The registry self-check is load-bearing:** if this pass ships anything the
   `notSupported` registry lists, suite 110 fails until the entry is removed.
   That is the design working — remove the entry in the same commit.

## The board, for orientation

Wall 41/43 (the 2 open ride QRY-4 and CONN-2 — not yours). Backlog 100%
dispositioned; `npm run pm` cross-examines it against git and will flag you if
a commit subject names a still-open id. CONN-2 (SMS) was trigger-fired and is
scheduled — likely the sprint after this one, or parallel if small.

## Read first

| | |
|---|---|
| [STATUS.md](STATUS.md) | One page: where everything stands |
| [../BACKLOG.md](../BACKLOG.md) | CONTRACT-1 row + detail section = the spec |
| [BURNDOWN.md](BURNDOWN.md) | Checkpoint discipline, the gate, receipts |
| `docs/ai-contract.md` | The review artifact — diff it as you go |
| suites 108, 109, 110 | The contract-test pattern to extend |
| `CLAUDE.md` | Build rules, ship ritual, wall conventions |

---

## The prompt

```
Read docs/pm/HANDOFF-CONTRACT-1.md, then docs/pm/STATUS.md and the CONTRACT-1
row + detail section in docs/BACKLOG.md.

Run CONTRACT-1: the full agent-facing language pass — every tool description,
get_project_info, list_field_types, error copy, and the generated client
(DX-1's search + idempotency), audited against live behavior. The method is a
systematic behavior-vs-description diff; every defect fixed lands with a
contract test in the suite-108/109/110 pattern, so the words are pinned to the
wire and cannot drift back.

Work in checkpoints per docs/pm/BURNDOWN.md: batch by surface, gate with
`npm run checkpoint`, commit, push. Run the full verify before the last push —
this session's contract changes broke a test written for the narrower old
contract, and only the full suite caught it. Close the CONTRACT-1 and DX-1
backlog rows with hashes when done.
```
