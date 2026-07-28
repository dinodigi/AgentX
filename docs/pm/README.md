# Project management — how work moves here

> Created 2026-07-26 because tracking had spread across five places with no
> authoritative one: plan docs, the feedback wall (in the production DB),
> `BACKLOG.md`, session memory, and operator-blocked flags buried as inline
> marks. Nothing aggregated them, so "where am I?" needed an archaeology dig.
>
> **This folder is the index layer.** It does not replace the existing docs —
> it points at them and answers *what is true right now*.

## The three files

| File | Answers | Who updates it |
|---|---|---|
| **[STATUS.md](STATUS.md)** | *What is happening right now?* Active sprint, what is blocked on the operator, what decision is pending. **One page. Read this first.** | End of every working session |
| **[BOARD.md](BOARD.md)** | *What is open, everything, in one list?* Every task with an ID, source, and state. | `npm run pm` regenerates the wall section; tracks are hand-maintained |
| **[sprints/](sprints/)** | *What did we commit to this sprint, and why?* | At sprint start; status marks inline as work lands |

## Where work comes from

Four sources, and they are not equal:

1. **The feedback wall** (`send_feedback` → `/admin/console/feedback`) — agents
   building on the platform report friction. **This is the highest-signal
   source**, because it is evidence from someone trying to get something done.
   Two independent reports of the same thing is close to proof.
2. **Discovered while building** — the drift, the bugs found mid-task. Goes
   straight to a sprint or `BACKLOG.md`; never left in a chat log.
3. **[../BACKLOG.md](../BACKLOG.md)** — ideas and parked decisions. Things we
   have *not* started. Deliberately separate from in-flight work, but **not
   hidden**: `npm run pm` parses it and surfaces every high-priority unshipped
   item into BOARD.md. The separation is conceptual (a sprint is a commitment,
   the backlog is a list) — it is not an excuse to lose sight of it.
   *It rots the same way the wall does:* on 2026-07-26 three HIGH items
   (MT-1, OPS-4, DX-6) still read "not started" days after shipping. Mark items
   shipped with a commit hash when a sprint closes.
4. **Operator decisions** — direction changes, priorities, product calls.
   Recorded in the sprint doc so the reasoning survives.

## The lifecycle

```
wall report / idea
   → VERIFY (reproduce before fixing — this rule has caught us four times)
   → BACKLOG.md  (not started)  or  a sprint  (committed)
   → build + test
   → ship  → mark the sprint  → disposition the wall row WITH a receipt
```

**The step people skip is the last one.** On 2026-07-25 the wall read 20 open
items when 18 were already fixed — the instrument was lying because nobody fed
it. A dashboard that overstates by 10× trains you to stop reading it.

## Rules that earned their place

- **Reproduce before fixing.** A failing test or live repro is the source of
  truth, never the report's narrative. Four times now a reporter has been right
  about the symptom and wrong about the cause — and once (the `APP_URL`
  incident) the reporter was right and *our triage* was wrong.
- **Prioritise by independent confirmation.** Two unrelated testers hitting the
  same thing beats one loud report or our own taste.
- **A sprint is a commitment, the backlog is a list.** Do not blur them; that
  is how a sprint becomes a wishlist.
- **Blocked-on-operator items get ⚑** so they are greppable and never silently
  stall a sprint.
- **Every disposition carries a receipt** — a commit hash, or the verification
  that settled it.

## Status vocabulary

`⬜ open` · `🚧 in progress` · `✅ done` · `🅿️ parked (with the reason)` ·
`⚑ needs the operator`

## Commands

```bash
npm run pm          # refresh BOARD.md's wall snapshot from the live DB
```
