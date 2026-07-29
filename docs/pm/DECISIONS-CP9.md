# CP9 — the decision round

> **Durable**, written 2026-07-29. The last 4 wall items. Each is stated as
> options with a recommendation, so this is one sitting rather than three
> interruptions. Say yes/no/other per item; I execute from there.

---

## D1 · `auth_kit` leaves credential handling to every tenant

**Item** `0ceec805` (jabed test) — the most thorough report on the wall.

They had to choose argon2id parameters, build lockout, and — the subtle one —
use a **real dummy hash** on unknown emails so response latency does not
enumerate accounts. Their words: *"subtle enough that I would expect many
integrators to miss it."* They are right, and a first version that misses it
leaks silently.

### A correction to my own earlier framing

I previously said storing credentials would "change our breach profile." That
was wrong, and it matters for this decision. **We already hold the bytes** — the
reporter's argon2id hashes are sitting in a tenant database *we* provision and
operate. A Pluggie breach already exposes them.

So the real question is not *whether we hold credential material*. It is
**whether we take responsibility for it being correct.** "Credential-free by
design" describes our API surface, not where the data physically lives.

### Options

| | Option | Consequence |
|---|---|---|
| **A** | Become an identity provider — we store and verify credentials as a service | Largest scope; we own password reset, MFA, session revocation forever. Real product, wrong sprint. |
| **B** | Verified reference implementation — `auth_kit` v2 ships the correct recipe as a plugin | Tenants still hold their own data; we supply the tested pattern. Medium build. |
| **C** | Stay out, document the trap loudly | Cheapest. Also the only option that is *silently* dangerous — the current position. |
| **D** ⭐ | **Platform primitives that make the trap hard to hit, plus B** | `SEC-1` (write-only field type) + hardened `auth_kit` v2. |

### Recommendation: D

`SEC-1` — a **write-only field type**, never returned by any read (MCP, delivery,
export, versions, changes feed) — is already in the backlog at HIGH priority for
independent reasons (BYO-key patterns). It is the single highest-leverage thing
here: today a credential in a normal field is plaintext in the admin UI, in
exports, and in the changes feed. That is a worse exposure than the hashing
parameters jabed worried about, and it is ours to fix.

Pair it with an `auth_kit` v2 whose workflow encodes the dummy-hash timing
defence, lockout, and single-use non-enumerating reset tokens, and integrators
get the correct implementation by default without us becoming an identity
provider.

**Cost:** SEC-1 is a real build — it touches read projection, export, entry
versions, and the changes feed, and every one of those is a place a secret could
leak if missed. Call it a checkpoint of its own.

---

## D2 · Workflow transitions gate on WHO, never on WHAT

**Item** `6809681c` (jabed test).

Cannot say *"may not go live without a creative"*, so the rule becomes a
**required field** — which then blocks saving a draft. The constraint lands at
the wrong moment: at every save, instead of at the one transition that cares.

### Recommendation: just build it — I do not think this needs a decision

The vocabulary already exists. `when` clauses are used by events and schedules,
`buildWhere` is shared, and workflow transitions already validate an actor. Adding
a `when` precondition to a transition is a small, well-precedented change:

```
transitions: [{ from: "draft", to: "live", actors: ["operator"],
                when: [{ field: "creative", op: "exists", value: true }] }]
```

The only real question was whether it earns a slot, and with the wall at 4 it
plainly does. **Unless you object, I will treat this as scheduled rather than
open.**

---

## D3 · A browser-safe delivery credential ⭐ most urgent

**Items** `eff3e105` (xvibe) + `66d1cbd9` (Codex) — two reporters, and a measured
cost: **XVibe runs an edge proxy per app for the sole purpose of holding a
token.**

### Why this got more urgent this week

The domain split makes it structural. Every deployed app on `*.myxvibe.com` is a
**distinct origin** calling `api.plugster.dev` cross-origin. The per-app proxy
stops being one team's workaround and becomes the default shape of every site
the platform ships.

### The reframe that decides it

**This is a quota decision, not a security decision.**

A read-only + publicWrite-only token grants exactly what `publicRead` and
`publicWrite` already expose to the anonymous internet. If that data is public,
a leaked token leaks *nothing new*. What a public token actually costs you is
**abuse** — someone hammering your quota or spamming a form — and abuse is a
rate-limit and revocation problem.

### Options

| | Option | Consequence |
|---|---|---|
| **A** | Do nothing | Every static app needs a proxy. We ship that cost to every customer. |
| **B** ⭐ | **New token class: read + publicWrite only, safe to embed** | Deletes the proxy. Needs its own rate limit. |
| **C** | B **+ origin allowlist** (checked against `Origin`) | Stops casual reuse elsewhere. Not a real boundary — `Origin` is trivially forged outside a browser — so it is abuse-shaping, not security. |
| **D** | Short-lived minted tokens | Still requires a server. Reintroduces the proxy we are deleting. |

### Recommendation: B now, C as a follow-up

Ship the token class with its own per-token rate limit and instant revocation.
Add the origin allowlist after, and **document it honestly as abuse-shaping
rather than a security boundary** — anything else would be the kind of
overclaim this codebase has been careful to avoid.

**One thing to be deliberate about:** `publicWrite` from a browser is a spam
surface in a way `publicRead` is not. I would ship read-only first, and gate
browser-side `publicWrite` behind a per-origin rate limit — or leave it for a
second pass with a captcha hook.

---

## What I would do with a yes to all three

1. **D3 read-only token** — unblocks XVibe, deletes a per-app proxy
2. **D2 transition preconditions** — small, precedented
3. **CP10 backlog sweep** (41 items) — disposition everything
4. **D1 / SEC-1 write-only field type** — its own checkpoint, biggest of the four

D3 first because your own product is waiting on it.
