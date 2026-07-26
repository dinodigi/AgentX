# Design — how XVibe should relate to Pluggie

> Written 2026-07-25. Pairs with **PLUGGIE-DESIGN-BRIEF.md** (the house style,
> set 2026-07-10 and still current).

## The house style, in one line

Pluggie's direction is **futuristic / technical** — the earlier "paper-and-ink"
look was explicitly killed. Read PLUGGIE-DESIGN-BRIEF.md §2 before making
choices; it is a rebrand brief, not a suggestion.

## The actual question: sibling, twin, or stranger?

**Siblings.** Not twins, not strangers — and this is a deliberate call worth
holding to:

- **Not twins.** Pluggie's console and XVibe's studio serve different people
  doing different things. The console is an operator surface — dense, precise,
  scanned. The studio is a *creative* surface — a person is describing
  something and watching it appear. Cloning the console into the studio would
  make the studio feel like an admin panel, which is the opposite of the
  feeling the product needs.
- **Not strangers.** They share a company, and eventually a user crosses
  between them (Phase 1 literally opens the studio from inside the console).
  A hard visual break at that seam reads as two vendors, not one product.

**So: shared bones, different skin.** Inherit the family traits — the
futuristic/technical stance, the type discipline, the density and restraint —
and let XVibe carry its own accent and its own mood.

## The one rule the prototype already establishes

Open `prototype.html`. Notice that **the studio and the app it builds look
deliberately different**: the studio is a dark, tight, tool-like environment;
the preview pane renders in its own light world with a different accent.

That contrast is load-bearing, not decoration. It says: **XVibe makes real,
distinct products — not clones of itself.** If the studio and the generated app
share a look, every app built on XVibe looks like it was built on XVibe, which
is exactly the criticism levelled at template-y site builders. Keep them
visually separable.

## Practical guidance

1. **Read PLUGGIE-DESIGN-BRIEF.md §2** for the direction, then diverge on
   accent, not on stance.
2. **The generated app must not inherit XVibe's identity.** Its design belongs
   to the user (and eventually to themes/templates), not to the studio.
3. **The seam matters most.** The moment a user clicks "Build & deploy" and
   moves from console to studio is where sibling-not-stranger is judged.
   Continuity of type and stance carries it; identical color is not required.
4. **Dark studio is a defensible default** for a tool people stare at while
   working, but it is a choice — make it on purpose, and make sure the
   preview pane can render a *light* app convincingly inside it.

## Open (worth deciding early, cheap now, expensive later)

- **How loudly does XVibe say "runs on Pluggie"?** A quiet stack badge (as in
  the prototype's chrome) reads as credibility; a loud one makes XVibe feel
  like a demo of something else. This is a positioning decision with a visual
  consequence — it is also flagged as open in XVIBE-PLAN.
- **Does XVibe ship themes for generated apps?** If yes, that is a design
  system of its own and should be scoped as such rather than accreting.
