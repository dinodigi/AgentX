# Docs — how to read this folder

The story in one paragraph: the platform started as a scoped experiment (the
brief and A/B protocol are in [archive/](archive/)), grew through a formal
design phase ([gap-designs/](gap-designs/README.md)) and a subsystem build
([subsystems/](subsystems/README.md)), was productized for launch
([plans/LAUNCH-PLAN.md](plans/LAUNCH-PLAN.md)), and has since evolved through
post-deployment initiative plans ([plans/](plans/)). Point-in-time audits and
field reports ([reviews/](reviews/)) feed the next plan; operational knowledge
lives in [runbooks/](runbooks/); everything superseded drops into
[archive/](archive/).

## Living documents (start here)

| Doc | What it is |
| --- | --- |
| [CAPABILITIES.md](CAPABILITIES.md) | What the platform can do today, by surface — the system snapshot |
| [ARCHITECTURE-RATIONALE.md](ARCHITECTURE-RATIONALE.md) | Why it's built this way — the durable answer to "is the foundation correct?" |
| [OPS.md](OPS.md) | Ops runbook: what's wired in code vs. operator console setup |
| [BACKLOG.md](BACKLOG.md) | Single source of truth for ideas raised but not yet scheduled |
| [DESIGN-BRIEF.md](DESIGN-BRIEF.md) | The active design direction (futuristic/technical; marketing + platform UI) |
| [hooks.md](hooks.md) | Tenant-facing contract for before-write hooks |
| [ai-contract.md](ai-contract.md) | Auto-generated MCP tool contract (`scripts/dump-contract.ts` — do not hand-edit) |

## plans/ — initiative plans (chronological)

1. [LAUNCH-PLAN.md](plans/LAUNCH-PLAN.md) — productization: tracks, launch gates, dogfood intake
2. [STRUCTURED-FIELDS-PLAN.md](plans/STRUCTURED-FIELDS-PLAN.md) — group/array primitives, repeater editor (shipped)
3. [SCALE-AND-CONTENT-MODEL-PLAN.md](plans/SCALE-AND-CONTENT-MODEL-PLAN.md) — index layer, pagination, repeaters (shipped)
4. [SECURITY-REMEDIATION-PLAN.md](plans/SECURITY-REMEDIATION-PLAN.md) — fixes from the Hostile Agent v1 audit (shipped)
5. [POST-DEPLOYMENT-V1.0-PLAN.md](plans/POST-DEPLOYMENT-V1.0-PLAN.md) — CDN, caps/metering, blocks, plugins, SEO (shipped)
6. [POST-DEPLOYMENT-V2-PLAN.md](plans/POST-DEPLOYMENT-V2-PLAN.md) — current: relations-in-blocks, block library, email, SEO v2

## reviews/ — point-in-time audits & field reports

- [DEVELOPER-REVIEW-2026-07.md](reviews/DEVELOPER-REVIEW-2026-07.md) — external-style code review; answered by ARCHITECTURE-RATIONALE
- [SECURITY-PASS.md](reviews/SECURITY-PASS.md) — launch-gate security audit (token model, isolation)
- [FEEDBACK-TRIAGE-2026-07.md](reviews/FEEDBACK-TRIAGE-2026-07.md) — first agent-sourced feedback batch off the wall; drives current fixes

## runbooks/ — operational how-tos

- [CDN-SETUP.md](runbooks/CDN-SETUP.md) — Cloudflare edge cache: worker deploy, routes, verification curls
- [STATUS-PAGE-SETUP.md](runbooks/STATUS-PAGE-SETUP.md) — external uptime monitoring + public status page
- [backup-restore.md](runbooks/backup-restore.md) — the backup story
- [api-versioning.md](runbooks/api-versioning.md) — how the delivery API stays compatible
- [session-guidance.md](runbooks/session-guidance.md) — working-session conventions

## Historical corpus

- [gap-designs/](gap-designs/README.md) — the design phase: per-gap design docs + the subsystem map
- [subsystems/](subsystems/README.md) — the build phase: one doc per subsystem (ops, security, MCP, query, data, delivery, admin, events, identity, connectors)

## archive/ — superseded, kept for the record

Pre-launch history: [build-brief.md](archive/build-brief.md) (original product
brief), [ROADMAP.md](archive/ROADMAP.md) (phase roadmap, superseded by
LAUNCH-PLAN), [SYSTEM-REVIEW.md](archive/SYSTEM-REVIEW.md) (early full-system
review), [experiment/](archive/experiment/) (the A/B build experiment that
started it all), [deploy-netlify.md](archive/deploy-netlify.md) (pre-Render
deploy target).
