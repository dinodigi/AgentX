# Burn-down — the protocol for taking the board to zero

> **Durable.** Written 2026-07-28. This is the operating mode until the board is
> clear. It replaces "pick a sprint theme" as the way we choose work.

## The goal, stated honestly

**Take every open item on the feedback wall and the backlog to a disposition —
then, and only then, start new work.**

Not "build all 76 items." Some backlog entries are parked strategic bets where
"finishing" would mean inventing a decision that hasn't been made. Pretending
otherwise is how a board stays permanently amber.

**An item is closed when it has an answer, not when it has been built.** A
declined item with a written reason is genuinely closed — the reporter knows
where they stand, and we stop re-reading it every sprint.

## The four dispositions

Every open item lands in exactly one. No fifth option, no "we'll see."

| | Disposition | Means | Closes when |
|---|---|---|---|
| 🔨 | **SHIP** | Build it. | Code merged + test |
| 📝 | **ANSWER** | The behavior is right; the *explanation* was missing. Error copy, tool description, contract. No behavior change. | Copy merged + test asserting it |
| 🚫 | **DECLINE** | We are not doing this. | Reason written **into the wall reply**, so the reporter sees it |
| ⏳ | **TRIGGER** | Not now — but with a **named condition** that reopens it. | Trigger recorded |

**On ⏳ TRIGGER:** the trigger must be observable, not a feeling. "When a second
project asks for it" is a trigger. "Later" is not. This is the honest way to
close a parked item without claiming it's done — and it is the only disposition
that is allowed to move an item *out* of closed later.

**On 📝 ANSWER:** expect this to be the largest bucket. 12 of 32 open wall items
are filed `friction` — and friction is usually a documentation defect wearing a
bug costume. A2 and A4 were both ANSWERs and both closed repeat reports.

## The freeze

**Until the board reads zero, we do not start new work.**

Three exceptions, and they are narrow:

1. **Security.** Anything with an escalation or leak shape jumps everything.
2. **A live client is broken.** Not inconvenienced — broken.
3. **Under two minutes.** Cheaper to fix than to file.

**Incoming feedback is still recorded — just not worked.** The wall keeps
receiving; each new item gets a disposition at the next triage and joins the
queue in its bucket. Cutting off the signal to protect the burn-down would be
optimising the board instead of the product. `npm run pm` will show new arrivals
so we always know the true remaining number, including what landed today.

## Checkpoints

**A checkpoint is one coherent batch → gate → commit → push.** Target 60–90
minutes. Never leave more than one checkpoint's work unpushed.

The reason we've been sitting on four unpushed commits is that the only gate we
had cost 25 minutes. So there are now two gates:

```bash
npm run checkpoint -- 93 47
```

- `tsc --noEmit` → `next build` → **only the smoke files you name.** ~3–5 min.
- Refuses to build while a dev server is listening (shared `.next` — CLAUDE.md).
- The `next build` step is the one that matters: master auto-deploys, and tsc
  alone misses Next route-file export rules.

```bash
npm run verify
```

- Full 97-file suite, ~25 min. **Once per session**, before the last push of the
  day — it catches cross-talk between batches that targeted smokes cannot.

**Rule: every checkpoint ends pushed.** A green gate that isn't pushed bought
nothing.

## The loop

1. **Triage** — everything gets a disposition. Once, up front, then only for new
   arrivals.
2. **Batch by disposition, not by theme.** All the 📝 ANSWERs are one checkpoint;
   they touch the same files and share one test run. Mixing a design decision
   into that batch stalls the whole thing.
3. **Decision rounds.** 🔨 items blocked on an operator call get collected and
   asked **together**, with options and a recommendation. One sitting unblocks
   many items — far better than interrupting per item.
4. **Checkpoint → push.** Then repeat.
5. **Reconcile.** `npm run pm` after each checkpoint; the number must go down.
   It prints progress two ways, and the gap between them is the point:

   ```
   FEEDBACK WALL   ███████░░░░░░░░░░░░░  34% by effort
                   14/32 items closed (44% by count) · 34/99 effort points
   ```

   **By count flatters us.** The cheap items were batched first on purpose, so
   counting alone would make the burn-down look like it stalls later when it is
   really just meeting the bigger work. **By effort is the number to quote** —
   it weights each item by its `(S)`/`(M)`/`(L)` tag in [QUEUE.md](QUEUE.md).
   An open item with no tag counts as `(M)`, never zero: an untagged item must
   not be free. A duplicate report of a fix already counted is `(S)`, since it
   closes with the same commit.

   The backlog reports separately at 0% until CP10 — folding 44 untriaged items
   into one headline number would be a guess wearing a percentage.

## Definition of done for the burn-down

- `npm run pm` reports **0 open** on the wall (every row `resolved` or `declined`
  with a reason the reporter can read).
- `docs/BACKLOG.md` has no unshipped item without a disposition.
- Every 🚫 and ⏳ has its reason or trigger **written down** — because an
  undocumented decline reappears as a new report in six weeks, and we pay twice.
