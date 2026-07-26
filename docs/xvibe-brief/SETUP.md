# Setup — get a real Pluggie project to build against

> Do this before writing any XVibe code. Working against a **live** project is
> what makes the contract in CONNECTION.md real instead of theoretical, and the
> "first 30 minutes" checklist depends on it.
>
> **~3 minutes, and it must be done by the operator** — project creation and
> token minting both require a signed-in Pluggie session, and there is no API
> for either (CONNECTION.md §9).

## 1. The project — ALREADY CREATED ✅

The operator created and verified it on 2026-07-26. **Do not create another
one.**

| | |
|---|---|
| Name | **`xvibe`** |
| Project id | `29e647bc-1a7c-43dd-a2e3-6c309f37d021` |
| Plan / status | `managed` · `active` |
| Admin | `https://pluggie.app/admin/29e647bc-1a7c-43dd-a2e3-6c309f37d021` |

**Verified ready** (checked directly against the data plane, not assumed):

- **Tenant database: schema v1 = current, 9 tables.** The first
  `define_collection` works immediately — no cold-start migration gate.
- **R2: managed mode, bucket provisioned, public base URL live.** Uploads and
  image transforms work out of the box.
- **Clerk connected** (`discrete-urchin-42.clerk.accounts.dev`) — so
  owner/authenticated collections work rather than 503ing at request time.
- **Resend connected and `builtbystallion.com` is VERIFIED** — email actions
  genuinely send. (Ignore any advice elsewhere about unverified sending
  domains; it does not apply to this project.)
- Collections: **0** — a clean slate.

🔥 **This is a BURN project. Treat it as disposable.** The builder agent has
full authoring rights and will define, redefine and delete collections
constantly — that is its job. When it gets incoherent, wipe the collections or
delete and recreate. Never accumulate anything here you would miss, and never
point XVibe at a client project (Stallion, Hatchly, CSLP, Countryside…).

*XVibe's own operational data — its users, their apps, deploy history — will
live in a **separate** Pluggie project when Phase 2 needs it. Deliberately not
created yet, and the builder agent must never be pointed at it.*

## 1b. Connectors — what the project actually needs

On a **managed (hosted)** project the database and R2 bucket are provisioned
automatically. Nothing else is *required* to start. What you add depends on
what the agent will build — and the important nuance is **when each gate
fires**:

| Connector | Needed for | Fails | Recommendation |
|---|---|---|---|
| Database + R2 | everything | — | ✅ automatic on managed — nothing to do |
| **Clerk** | collections with `authenticated` / `owner` / claim access | ⚠️ **LATE** — the collection defines fine; the delivery API then answers **503 "this project has no auth issuer connected"** at request time | **Connect it up front** |
| Email (Resend) | email event actions, workflow transition emails | ✅ **EARLY** — `define_collection` refuses and names the remedy | Optional; 30 seconds |
| Stripe | `checkout` config | ✅ **EARLY** — refuses at define time | Skip unless demoing commerce |

**Why Clerk specifically.** Email and Stripe are gated at *define* time: the
agent tries, gets a clear refusal, adapts. That is a good failure. Clerk is not
gated at define time — a collection with `access: {read: "owner"}` defines
successfully and only fails when a real user reads it. An autonomous builder
will happily ship something that looks correct and 503s at runtime, which is
the worst failure shape available here. Any app with "my stuff vs your stuff"
hits this immediately.

**Email caveat (development-only annoyance).** Connecting Resend lets the agent
*define* email actions, but sends fail while the sending domain is unverified
(`403 … domain is not verified`). Expect defined-but-undelivered email in the
sandbox; it is a domain-verification chore on the Pluggie side, not an XVibe
bug.

## 2. Mint the mcp token

In that project: **Settings → Tokens** → label it `xvibe-dev` → scope
**`mcp (full)`** → **Mint token**.

**Copy it immediately — it is shown once** and only a hash is stored. If you
lose it, delete the row and mint another; they are free.

⚠️ The project ships with one auto-created token labelled *"created with
project"*. If its value was not captured at creation time it is unrecoverable —
**mint a fresh one** rather than hunting for it.

## 3. Put it in the environment, never in a file you commit

Copy `env.example` → `.env.local` and fill in:

```
PLUGGIE_MCP_TOKEN=agx_…            # from step 2
PLUGGIE_PROJECT_NAME=XVibe Dev
ANTHROPIC_API_KEY=…                # the agent's brain
```

Confirm `.env.local` is in `.gitignore` **before** pasting anything into it.

## 4. Prove the contract end-to-end (the real acceptance test)

Run these six calls against the live project. If all six pass, the integration
is proven and you can build the IDE on a known-good spine instead of debugging
connectivity while designing UI.

| # | Call | Expect |
|---|---|---|
| 1 | `tools/list` | ~60 tools |
| 2 | `get_project_info` | your project's name + `urls.deliveryBase` + a `briefing` |
| 3 | `define_collection` a toy collection | `ok: true` + a `convergence` note |
| 4 | `create_entry` a row | an id back |
| 5 | `get_client_code` | TypeScript with `DEFAULT_BASE_URL = "https://pluggie.app/api/v1"` |
| 6 | `mint_delivery_token` → `verifyConnection()` | *"base URL reachable, token accepted — you are connected"* |

**Step 5 is worth checking carefully.** If the base URL comes back as anything
other than `pluggie.app`, stop and report it — that exact symptom (a proxy
injecting its own host) cost a field agent three sessions before it was fixed
on 2026-07-23.

**Step 6 has a legitimate alternate pass:** if the project has no publicly
readable collection yet, `verifyConnection()` correctly answers *"base URL
reachable; no public collection to exercise the token against — connection
looks fine."* That is success, not failure.

## 5. Housekeeping

- **Rotate freely.** `revoke_delivery_token` + re-mint whenever a token might
  have leaked. Revoking a *minting* token cascades to everything it minted —
  that is a database-level guarantee, not app logic.
- **The wall is open to you.** When the platform gets in the way, call
  `send_feedback`. Bug reports need `evidence` (the request + verbatim
  response). This is the loop the whole product exists to close.
