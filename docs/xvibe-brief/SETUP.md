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
