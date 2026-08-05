# Compute — the experiment

> **Living — started 2026-08-04 on the `experiment` branch.** A roadmap, not a
> commitment. Nothing here ships to master until the open questions at the bottom
> have answers.
>
> Branch rules: **`experiment` never merges to master without a full verify and a
> deliberate contract rewrite.** Run its dev server with `.env.test` ONLY — never
> `.env`. A code runtime pointed at the production control DB, which currently
> shares `CONNECTOR_MASTER_KEY` with local dev, is the one configuration that
> could lose real data (ENV-1).

## Why compute at all

Every requirement beyond the declarative surface today needs the tenant to own a
server. That contradicts the shape of the thing being built: XVibe's premise is a
static app with no server, D3 shipped a browser-safe token to delete the proxy,
and the platform still says *"custom validation runs on YOUR endpoint"*.

The honest scoring, from the SWOT: compute solves **two** of the seven pains
currently on the board — *logic without a server* (which nothing else fixes) and
*third-party calls* (CONN-2/CONN-3). It does **not** solve MT-2, WP-7,
discoverability, or passwords. It is not a general answer, and it should not be
sold to ourselves as one.

## The thesis, stated so it can be checked later

**Compute for an agent platform is not "let tenants write code". It is "let the
agent write code AND prove it works".**

The differentiator is not execution — Supabase, Workers, Deno and Xano all
execute. It is that a function and its **fixtures** are one declarable artifact an
agent iterates against over MCP, and the platform **refuses to bind a function
whose fixtures fail**. That inverts the usual objection to arbitrary code: logic
stops being prose in a hook someone hopes is right and becomes executable and
assertable.

The precedent is already in the repo and already works: `test_hook` (dry-run a
hook, structured verdict, write nothing), `dryRun` on `define_collection`, plugin
`acceptance` arrays, and the contract tests themselves. Every well-received
feature here has the same shape — **let the agent verify**. Compute must follow
it or it degrades the platform it is added to.

**If the fixture harness is cut for time, the feature is not worth shipping.** It
is the feature; the runtime is the plumbing.

## Architecture: a new TARGET, not a new product

Compute is not a fourth surface. It is a new target for four abstractions that
already exist:

| Existing | Today | With compute |
|---|---|---|
| `hooks.beforeCreate` / `beforeUpdate` | `{url, mode, onError, timeoutMs, when}` | `fn` as an alternative to `url` — everything else unchanged, including `test_hook` |
| `events.created/updated/deleted` | `{type:'webhook'\|'email'}` | `{type:'function', fn}` |
| workflow `transitions[].actions` | same event actions | same |
| `define_schedule.action` | `webhook\|email\|mutate` | `{type:'function', fn}` |

No new public endpoint. `deliveryApi` and the MCP endpoint are untouched. That is
also what keeps the merge surface small — build in a new `lib/compute/` module and
the shared-file change is a handful of lines, which matters because `tools.ts` is
3,700 lines and the sprint branch edits it too.

### Execution

**Worker-thread pool on the same host.** Process-isolated so a runaway cannot
take the API down, co-located so there is no internet hop. Hard timeout via
`terminate()`, memory cap, concurrency cap.

The in-core advantage is the whole reason to do it this way: `ctx.entries.query()`
is a **direct call into `lib/entries.ts`**, not an HTTP request. A hook that needs
a related row costs microseconds. A separated compute product would have to come
back through the public API — an extra hop on the one path that is synchronous and
budget-bound (5s).

**Do not write the sandbox.** If isolation ever needs to be real (multi-tenant,
post-six-months), move to Cloudflare Workers or Deno subhosting rather than
hardening our own. Less code we own, and the same choice we would make at scale,
so there is no migration.

### What makes it declarative

Not the body — the five things around it. **A function is to compute what a
collection is to data:** the shape is enforced, the contents are the tenant's
business. `capacity: 2` has no opinion about the value; it enforces how many rows
may share it, in the database, whether the caller cooperates or not.

| Declared and enforced | Opaque |
|---|---|
| **Trigger binding** — which path, with a `when` clause | |
| **Capability grant** — the exact list, and nothing else in `ctx` | the body |
| **I/O shape** — typed in, typed out | |
| **Fixtures** — must pass before it binds | |
| **Budget** — timeoutMs, memory, invocation cap | |

**The capability grant is load-bearing.** No ambient `fetch`, no ambient DB
handle, no filesystem, no control plane. "What can this thing reach" must be
answerable by reading the declaration, never by reading the code.

**Hold this line even single-tenant.** It is nearly free now and nearly
impossible to add once something depends on a shortcut, and it is the single
property that makes compute publicly viable later. The moment a function gets
ambient `fetch` "for convenience", the declaration becomes a comment.

## The surface, as sketched

```
define_function {
  name: "promote_from_waitlist",
  trigger: { on: "events.updated", collection: "bookings",
             when: [{ field: "status", op: "eq", value: "cancelled" }] },
  capabilities: ["entries.read:waitlist", "entries.write:waitlist",
                 "entries.write:bookings", "email.send"],
  timeoutMs: 3000,
  body: "...",
  fixtures: [
    { name: "promotes the earliest waitlist row",   given: {...}, expect: {...} },
    { name: "skips a row whose hold expired",       given: {...}, expect: {...} },
    { name: "no-ops when the waitlist is empty",    given: {...}, expect: {...} },
    { name: "a replayed event promotes nobody twice", given: {...}, expect: {...} }
  ]
}

test_function { name } -> { verdict, results: [{ fixture, pass, ms, diff? }] }
list_functions        -> [{ name, trigger, fixtures: "6/6", p95, lastRun, bound }]
delete_function { name }
```

The worked scenario this was designed against: *"when someone cancels, promote the
first person off the waitlist; give them two hours to confirm, else move on."*
That is **multi-entry orchestration**, which `BOUNDARIES` explicitly declines, so
it cannot be expressed today at any price. Without compute it costs a server, HMAC
verification, a stored token, a callback client, registration, idempotency, a
timer, loop protection, deploy-then-test-in-prod, and owning the uptime of a gate
that can block writes — ten artifacts across three systems, none of it verifiable
by the agent that wrote it.

## Phases

**Phase 0 — the contract checklist (do this FIRST, before any code).**
Run `npm run verify` on this branch and collect the failures. They are the
complete list of claims compute invalidates, mechanically derived instead of
remembered. Expect at minimum:
- **suite 110's self-check** on `CONN-3` — the registry calls a generic
  third-party proxy *declined*, and compute makes that false;
- **108 / 109 / 114** wherever they pin *"no arbitrary code"*, *"no expression
  language"*, *"never hosts or evaluates tenant code"*, *"no multi-entry
  orchestration"*.

Then write the replacement text before implementing, because it decides the shape:

> Pluggie evaluates only **declared** functions. Every function names its trigger,
> its capabilities, its I/O shape and its budget, and cannot bind to a write path
> until its fixture suite passes. There is no ambient runtime: a function cannot
> open a socket, touch the filesystem, reach the control plane, or read a
> `writeOnly` field. What it may do is the list it declared.

That is checkable, testable, and stronger than *"we never run your code"*.

**Phase 1 — hooks without a server.** The narrowest useful slice: `fn` on
`hooks.beforeCreate`/`beforeUpdate`, the worker pool, `ctx.entries` read-only, the
fixture harness, `test_function`. Needs **zero** privileged access — the hook
envelope already carries the candidate. `test_hook` defines what good looks like.

**Phase 2 — events + schedules.** `{type:'function'}` on both. Async, so the
budget is looser and failures land in `get_deliveries` like every other action.

**Phase 3 — capabilities that reach outward.** `ctx.fetch` through the existing
`webhookTargetRefusal` SSRF guard; `ctx.secrets.get()` via `lib/crypto.ts`. This
is what absorbs CONN-2 (SMS) and CONN-3, and it is the first phase where a
function can do something the platform could not already do for it.

**Phase 4 — metering.** Invocations and CPU-ms onto the caps/metered rails that
already exist and sit inert. This is the revenue line, and it is also the only
brake on a runaway loop of our own making.

## What compute does NOT get, on purpose

- **Reading a `writeOnly` field.** SEC-1's guarantee is that the field's name
  never appears in any read payload. A function is a read. So `verify_credential`
  (SEC-3) stays a **platform primitive** — and note this holds whether compute is
  in-core or separate, which is why compute must not be used to justify SEC-3.
- **Control-plane access.** No tokens, no connectors, no `project_members`.
- **Filtering or sorting by a computed result.** A function output is not an
  index.

## Open questions — answer before writing code

1. **Sandbox: our own worker threads, or Cloudflare Workers / Deno from day one?**
   This one choice decides most of the abuse story and the migration story.
2. **Is the driving use case really *hooks without a server*?** If yes, Phase 1
   alone may be enough for six months, and it needs no privileged access at all.
3. **Fixture storage.** With the function (one artifact, versioned together) or
   separately? Together is what makes "the fixtures gate the binding" coherent.
4. **What happens to a bound function whose fixtures later fail** — because the
   schema changed under it? Unbind automatically, or flag and keep running? Both
   are defensible; silent divergence is not.
5. **Language.** JS only, or TS compiled at define time? TS gives the agent types
   from the collection schema, which is a real accuracy win.

## Sequencing against the rest of the board

**ENV-1 first.** Not a security argument at this scale — local dev currently
shares production's control DB *and* `CONNECTOR_MASTER_KEY`, so connecting a
connector "locally" switches a real project and 185 orphaned test projects already
accumulated. Adding a code runtime to an environment where dev and prod are
indistinguishable is how you lose your own data, with no attacker involved. ENV-1
also fires **MT-6**'s trigger, which is the same verify-it pattern compute needs.

`staging` branch: deferred until ENV-1 gives it somewhere to deploy. Naming it
`staging` when it happens, because `render.yaml` and ENV-1's design assume that
name.
