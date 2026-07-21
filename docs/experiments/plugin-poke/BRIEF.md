# Plugin System Audit — adversarial poke brief

**Mission.** Install every plugin Pluggie offers, compose them, operate them,
and then actively try to break them. Report everything that cracks.

**Authorization.** You are testing the operator's OWN platform with their
explicit request, using a token scoped to your own project. Everything here is
in-scope *for that project*. Two hard boundaries: never attempt to reach
another tenant's data except through the isolation probes below (which are
designed to be safely refused), and never run destructive operations against a
project you were not given.

**What "success" looks like.** Not a clean bill of health — *findings*. A run
that reports nothing is a run that didn't push hard enough. Bugs, confusing
errors, missing capabilities, and contradictions between what a plugin
promises and what it does are all valuable.

---

## Phase 0 — orient

1. `get_project_info` — read the `briefing` block. Note what it says.
2. `list_plugins` — record every plugin, its `version`, `provides`, `requires`.
3. `list_field_types`, `list_collections` — know your primitives.

**Watch for:** does the briefing tell you anything actionable? Does
`list_plugins` make it obvious what each plugin is *for* and what it would
conflict with? If you can't tell which plugin to use for a job without opening
each one, that's a discoverability finding.

## Phase 1 — composition (the newest, least-exercised code)

The rule: **one active provider per capability.** Test that it holds and that
its errors teach you the way out.

1. Enable plugins one at a time. Record which auto-enable others via
   `requires`, and whether the response explains what it did.
2. **Force a conflict:** enable two plugins that `provide` the same capability
   (e.g. `contact_forms` and `countryside_crm` both provide `lead_capture`).
   - Does it refuse? Does the error name the current provider *and* the remedy?
   - Retry with `swap: true`. Did the right plugin get disabled? Did any
     content disappear (it must not)?
3. **Break the dependency chain:** enable a plugin that `requires` a capability
   with no provider, then one with several possible providers. Are both
   outcomes clearly explained?
4. **Disable a provider that something else depends on.** You should get a
   warning naming the dependents — not silence, and not a block.
5. Author a private plugin with `define_plugin` that declares a capability
   already provided by a global plugin. What happens on enable?

## Phase 2 — apply and operate every plugin

For each plugin: `get_plugin`, apply its `structure.baseline` via
`define_collection`, then verify **its own `acceptance` array** item by item.
The acceptance list is the plugin's promise — treat any item that doesn't hold
as a bug in that plugin.

Cover all of them: `auth_kit`, `notification_kit`, `booking`, `waitlist`,
`feedback_wall`, `media_gallery`, `contact_forms`, `seo`, and `countryside_crm`
(this one conflicts with others — test it in isolation or after a swap).

**Watch for:** does the `reconcile` guidance actually work when collections
already exist? Two plugins that both want a `users` collection is the
interesting case — does the second one cleanly defer, or does it try to
redefine and get blocked?

## Phase 3 — adversarial probes

This is the core. For each probe, the expected result is a **clean refusal**.
A success where a refusal belongs is a security finding — file it immediately.

**Identity and privilege**
1. Using the **delivery** token, call an MCP tool. Expect a scope refusal.
2. Using the **MCP** token, call `/api/v1/*`. Expect `E_SCOPE` naming the fix.
3. Public-POST to a `publicWrite` collection while setting a `writableBy:"none"`
   field (`status`, `role`, `invite_code`, `dedupe_key`, `recipient`). Expect 403.
4. Sign in as a plain member (if you wire an issuer) and try to PATCH your own
   role to admin.

**Workflow integrity**
5. `create_entry` with an explicit non-initial workflow state. Expect refusal —
   *and* check the error teaches you `allowExplicitWorkflowState`.
6. Use that escape hatch from a **delivery** write. It must not be reachable.
7. Transition along an undeclared edge (e.g. `archived → draft`). Expect refusal.
8. Redefine a collection while omitting its `workflow`. It must demand `confirm`.

**Data boundaries**
9. `media_gallery`: fetch an unpublished album from the delivery API. It must be
   invisible — check the raw JSON, not just the UI.
10. Query a collection with no `publicRead` fields over delivery. Expect 404.
11. Tamper with an `export_entries` cursor (flip characters, inject SQL-ish
    text). Expect a clean validation error, never a stack trace or a leak.

**Uniqueness under pressure**
12. `booking`: fire two identical bookings for the same resource+date+slot
    **simultaneously** (parallel calls). Exactly one may win.
13. `waitlist`: same email twice. `notification_kit`: same `dedupe_key` twice.
    `auth_kit`: two memberships for the same user+org.

**Scheduled mutations (AUTO-1)**
14. Define a `mutate` schedule with: no `where` clause; a `set` on the workflow
    field; a `set` on a computed field; a transition no `mcp` actor can reach;
    a bogus operator. Each must be refused at define time with a useful message.
15. Define a legitimate sweep, then verify the `guard` actually protects rows
    that changed after selection, and that the audit trail names the schedule.

**Ingestion and injection**
16. `upload_asset` with `url` pointing at: a private IP (`10.x`, `192.168.x`),
    cloud metadata (`169.254.169.254`), a redirect chain, and plain `http`.
    All must be refused.
17. Submit oversized payloads (very long strings, deeply nested arrays,
    hundreds of array items). Expect bounded errors, never a 500.
18. Store text containing `{{template}}` syntax, SQL fragments, and HTML/script
    tags. Verify nothing is interpolated or executed where it's later read.

**Isolation**
19. Author a project-private plugin via `define_plugin`. From a *second*
    project's token, confirm it's invisible.
20. Attempt to author a plugin whose `id` collides with a built-in.

## Phase 4 — the update loop

1. Note the `version` of each enabled plugin.
2. Ask the operator to bump one in the catalog (or observe it happening).
3. Re-run `get_project_info` — does `briefing.updates` offer it? Does a major
   bump land in `briefing.attention`?
4. Adopt the update: re-read `get_plugin`, reconcile, then `enable_plugin`
   again to acknowledge. Does the offer clear?

**Watch for:** anything that auto-applies without your say-so. Nothing should.

---

## How to report

Everything goes through `send_feedback` — that's the operator's queue.

**A `bug` requires receipts.** The tool will refuse one without them:

```
send_feedback {
  category: "bug",
  summary: "<one sentence, what broke>",
  detail: "<expected vs observed, and why it matters>",
  toolName: "<the tool/endpoint involved>",
  evidence: {
    request:  "<the EXACT call you made — tool + args, or the HTTP request>",
    response: "<the VERBATIM error or response you got>",
    reproduction: "<minimal steps>"
  }
}
```

Rules the tool enforces, so save yourself a round trip:
- Quote errors **verbatim** — paraphrases are worthless for triage.
- One distinct issue per call.
- Report only what **you directly observed this session**. No speculation.
- Retry once before reporting anything that might be transient.
- Never include tokens or secrets in evidence.
- Can't reproduce it? File it as `friction` with what you saw — don't force it
  into `bug`.

Use `limitation` for "the platform can't express X", `friction` for "this was
confusing or harder than it should be", `idea` for suggestions.

**Report the near-misses too.** A refusal with a message that didn't tell you
how to proceed is a finding. So is a capability you expected and couldn't find.

## Definition of done

1. Every plugin enabled, applied, and its acceptance array verified.
2. Every Phase 3 probe attempted, with the outcome recorded.
3. Every finding filed via `send_feedback` with receipts.
4. A closing summary: what held, what cracked, and the three things that would
   most improve the plugin system.
