# Kickoff — the two messages (Codex CLI)

> One brief, two arms. `BRIEF.md` goes into **both** repos **byte-identical**.
> Only the kickoff message differs, and only in its first paragraph.
> Operator-only file — never show it to either session.

## Prep (before starting either clock)

1. Two empty repos: `northgate-a` (Pluggie arm) and `northgate-b` (control).
2. Copy `BRIEF.md` into the root of each. Nothing else — no PROTOCOL.md,
   no hints, no `.mcp.json`.
3. **Arm A only:** in the Pluggie admin create project "Northgate Pottery"
   (`#c2410c`) and copy its `agx_` MCP token. Do **not** pre-enable any
   plugins — discovery is part of what you're measuring.
4. **Arm B only:** make sure it can actually run a database locally
   (Postgres or SQLite). It should have to *set one up* — that's a real cost
   of building from scratch — but it must not be *blocked* by having no
   credentials at all. That's the difference between measuring slower and
   measuring impossible.
5. Same model, same approval mode, fresh sessions, same day.

**Timing note:** Codex loads MCP config at startup. Do Arm A's registration
and restart **before** you start its clock, or you'll be timing a restart
cycle you then have to subtract.

---

## Message A — Pluggie arm (`northgate-a`)

```
Register the Pluggie MCP server for this project. Create `.codex/config.toml`
in the repo root containing:

[mcp_servers.pluggie]
url = "https://pluggie.app/api/mcp"
bearer_token_env_var = "PLUGGIE_TOKEN"

Set PLUGGIE_TOKEN in your environment to: <PASTE_THE_agx_TOKEN>
Then restart Codex so the server loads, and confirm the pluggie tools are
available before you begin.

Now read BRIEF.md and build it. Use the pluggie MCP tools for the data layer,
admin, and content API rather than building your own. Work until the
definition of done is met.
```

## Message B — control arm (`northgate-b`)

```
Read BRIEF.md and build it. Work until the definition of done is met.
```

---

## Why the messages look lopsided

Arm A's extra text is **setup only** — registering a server and confirming it
loaded. The build instruction is the same sentence in both: *read BRIEF.md and
build it, work until the definition of done is met.* Arm A gets one added
clause — "use the pluggie MCP tools rather than building your own" — which is
the independent variable itself, not a hint about *what* to build.

What Arm A is deliberately **not** told: that plugins exist, which ones to
enable, or that anything is installable. If it never calls `list_plugins` and
hand-rolls collections instead, that's a real finding about discoverability —
record it rather than correcting it mid-run.

## During the run

- Answer blocking questions equally and minimally. Never coach on approach.
- Never rescue either arm from an error — "please fix it" and count it.
- If Arm A asks whether it may install something: "your call." Nothing more.
- Stop at the session's first "done" claim, or 4 hours wall-clock.

Scoring, invariant tests, and what to record: `PROTOCOL.md`.
