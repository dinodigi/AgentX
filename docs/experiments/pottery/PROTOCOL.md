# Experiment Protocol — Pluggie arm vs. from-scratch arm

> **Operator-only. Do not show this file, or mention the experiment, to either
> session.** A control arm that knows it's being raced behaves differently.
> Both sessions get `BRIEF.md` verbatim and nothing else.

**Question being tested:** how much faster is the same build on Pluggie's
plugin catalog than from scratch — and do the hard invariants survive in both?

**Second question (the plugin goal):** does an agent *discover and compose* the
catalog unprompted? The brief never mentions plugins. If Arm A hand-rolls
collections it could have installed, that's a finding about `list_plugins`
discoverability, not a failure of the run.

## Setup

| | Arm A (Pluggie) | Arm B (control) |
|---|---|---|
| Repo | `C:\dev\northgate-a` (empty) | `C:\dev\northgate-b` (empty) |
| Backend | Pluggie over MCP | whatever it chooses |
| Extra file | `.mcp.json` | none |

**Arm A prep:** in the Pluggie admin create project "Northgate Pottery"
(`#c2410c`), copy the revealed `.mcp.json` into `northgate-a`. Do **not**
pre-enable any plugin — discovery is part of what's being measured. Leave the
plugin catalog exactly as it ships.

**Both arms:** same model, same permission mode, fresh sessions, same day.
Arm B gets a fair stack — if it picks Next.js + Postgres + an ORM + an auth
library, that's a real-world control, not a handicap.

## Kickoff prompts (identical except one sentence)

Arm A:
> Read BRIEF.md and build it. An MCP server ("pluggie") is connected in this
> repo — use its tools for the data layer, admin, and content API rather than
> building your own. Work until the definition of done is met.

Arm B:
> Read BRIEF.md and build it. Work until the definition of done is met.

## Rules during the run

- Answer blocking questions equally and minimally; never coach on approach.
- Never rescue either arm from an error — say "please fix it" and count it.
- If Arm A asks whether it may install something, say "your call" — nothing more.
- Stop condition: the session claims done, or 4 hours wall-clock, whichever first.

## Record (per arm)

- Wall-clock start → first "done" claim; and time to each milestone below.
- Interventions: every message beyond the kickoff (count + why).
- Errors observed: build failures, runtime crashes, wrong behavior found later.
- Files created and total lines of application code written.
- Tokens/cost if visible.

**Milestones** (timestamp each): data layer modeled · auth working · first
booking created · public site rendering real data · dashboard usable · seeded ·
claims done.

## Scoring — run AFTER each arm claims done

Test these yourself. Never ask the session whether something works.

**Functional (1 pt each)**
1. Public home renders featured classes + published albums
2. Unpublished album is invisible on the public site (check the API/HTML, not just the UI)
3. Class waiting-list form works; the same email twice is refused
4. Enquiry form validates client-side AND server-side (submit garbage via curl)
5. Sign-in works; a member sees only their own bookings
6. Booking a free slot succeeds; booking a taken slot is refused with a clear message
7. My-bookings cancel works
8. Notification feed shows unread count; mark-read decrements it; muting a topic works
9. Member feedback submits and appears in the dashboard as `new`
10. Dashboard triage moves feedback through the pipeline
11. Gallery album create + image upload + publish appears publicly
12. Announcement drafts, then publishes to members
13. Invite / suspend a member; a suspended member cannot book
14. README explains running it + Jonah's five common tasks

**Invariants (2 pts each — this is where hand-rolled builds usually crack)**
15. **Concurrent double-book:** fire two bookings for the same equipment+date+slot
    simultaneously (`curl` in parallel). Exactly one may win.
16. **Role escalation:** as a signed-in `member`, PATCH your own role to `admin`
    directly against the API. Must be refused.
17. **Status forgery:** submit feedback with `status: "done"` set in the payload.
    Must be refused or ignored — never stored.
18. **Waitlist duplicate:** same email twice via the API. Must be refused.
19. **Stale holds:** an unconfirmed hold older than 24h is released without
    manual action (fast-forward a timestamp in the DB and let the mechanism run).
20. **Notification dedupe:** deliver the same booking-confirmed notification
    twice. The member must see it once.

**Plugin coverage (Arm A only — the catalog goal, not scored against Arm B)**

Record which of these Arm A enabled vs. hand-rolled:
`auth_kit` · `booking` · `waitlist` · `notification_kit` · `feedback_wall` ·
`media_gallery` · `contact_forms` · `seo`

`countryside_crm` is deliberately out of scope — it's a client-specific
vertical, and under the one-active-provider-per-capability rule it would
conflict with `booking` and `contact_forms` anyway. Confirming that conflict
message appears if Arm A tries to enable it is itself a valid observation.

## What to write up

Time to done per arm, milestone-by-milestone deltas, functional + invariant
scores, LOC written, and — most interesting — **which invariants Arm B got
wrong**. A faster build that double-books is not a win; the honest headline is
speed *and* correctness together.

Anything Arm A's agent struggled with goes on the feedback wall through
`send_feedback` with receipts, exactly like a real project would.
