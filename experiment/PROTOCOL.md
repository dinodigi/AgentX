# Experiment Protocol — AgentX arm vs. from-scratch arm

**Do not show this file or mention the experiment to either session.** The
control arm changes behavior if it knows it's being compared. Both sessions get
`BRIEF.md` verbatim and nothing else about the other arm.

## Setup

| | Arm A (AgentX) | Arm B (control) |
|---|---|---|
| Repo | `C:\dev\tidewater-a` (empty) | `C:\dev\tidewater-b` (empty) |
| Backend | AgentX over MCP | Whatever it chooses |
| Extra file | `.mcp.json` (below) | none |

Arm A prep: keep the AgentX dev server running. In the AgentX admin, create
project "Tidewater Expeditions" (#0e7490), copy the revealed `.mcp.json` into
`tidewater-a` before starting the session.

Webhook: create a fresh URL at https://webhook.site and give the SAME url to
both arms when they ask (or include it in the kickoff prompt).

Both arms: same model, same permission mode, fresh sessions, started the same day.

## Kickoff prompts (identical except one sentence)

Arm A:
> Read BRIEF.md and build it. An MCP server ("agentx") is connected in this
> repo — use its tools for the data layer, admin, and content API rather than
> building your own. Webhook URL for inquiries: <URL>. Work until the
> definition of done is met.

Arm B:
> Read BRIEF.md and build it. Webhook URL for inquiries: <URL>. Work until the
> definition of done is met.

## Rules during the run

- Answer blocking questions equally and minimally; never coach on approach.
- Don't rescue either arm from an error — say "please fix it" and count it.
- Stop condition: the session claims done, or 3 hours wall-clock, whichever first.

## Record (per arm)

- Wall-clock start → first "done" claim.
- Interventions: every message you sent beyond the kickoff (count + why).
- Errors you observed: build failures, runtime crashes, wrong behavior found later.
- Tokens/cost for the session if visible.

## Scoring — run AFTER each arm claims done

Functional (1 pt each, test yourself, don't ask the session):
1. Home shows featured trips and ONLY approved testimonials
2. /trips filter by difficulty actually requeries and is correct
3. /trips sort by price ascending/descending is correct
4. Trip detail shows guide card + departures with correct status badges
5. Sold-out departure is not bookable in the UI
6. Inquiry form: client validation, server validation (submit garbage via curl), success state
7. Inquiry appears in admin, newest first; mark-handled works
8. Webhook fired on submission (check webhook.site)
9. Admin CRUD: create a new trip end-to-end incl. image upload; it appears on the site
10. Testimonial approve flow works (pending → approved → visible on site)

Privacy audit (2 pts each — these are the differentiators):
11. Public API/pages leak no guide email or day rate (inspect every public endpoint)
12. No margin/capacity notes anywhere public
13. Booking inquiries completely unreadable publicly (try direct API calls)
14. Bad input rejected server-side: invalid difficulty, dangling departure→trip
    reference, missing required fields (test via curl, not the UI)

Handoff quality (subjective 0–5 each):
15. Would you hand this admin to a real client? (branding, clarity, polish)
16. Content quality of the seeded data

Max score: 30. Record score, time, interventions, errors per arm.

## Afterward

- Arm A friction log → feeds ROADMAP.md Phase 2.4 (every wall it hit is a
  roadmap item candidate: bulk create, get_entry, missing field formats, etc.)
- Arm B's backend code volume is worth noting: that's the code AgentX makes
  unnecessary — or doesn't.
- If Arm B wins or ties: that is real evidence about the product. Take it seriously.
