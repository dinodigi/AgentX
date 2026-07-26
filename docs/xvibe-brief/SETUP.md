# Setup — get a real Pluggie project to build against

> Do this before writing any XVibe code. Working against a **live** project is
> what makes the contract in CONNECTION.md real instead of theoretical, and the
> "first 30 minutes" checklist depends on it.
>
> **~3 minutes, and it must be done by the operator** — project creation and
> token minting both require a signed-in Pluggie session, and there is no API
> for either (CONNECTION.md §9).

## 1. Create the project (Pluggie console)

1. Sign in at **https://pluggie.app** → **New project**.
2. Name it something unmistakably a sandbox: **`XVibe Dev`**.
3. Pick a plan. `sandbox` is free but **limited to one per workspace** — if
   that slot is taken, use a paid plan or reuse an existing throwaway project.

⚠️ **Do not point XVibe at a client project** (Stallion, Hatchly, CSLP,
Countryside…). The builder agent has full authoring rights: it can redefine
collections and delete data. Use a project you would not mind losing.

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
