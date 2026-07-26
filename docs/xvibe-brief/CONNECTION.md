# XVibe ↔ Pluggie — the connection contract

> **Written 2026-07-25, before either side started, deliberately.** This is the
> interface both codebases build against. Everything else in this folder is
> context; **this file is the contract.**
>
> Governing rule, from XVIBE-PLAN.md: **XVibe is a CLIENT of Pluggie, never a
> fork.** It talks over the public MCP + HTTP surfaces only. If XVibe ever
> imports Pluggie source, the boundary is gone and you own a fork — enforce it
> mechanically (see §6).

## 1. The two surfaces, and who talks to which

Pluggie exposes exactly two network surfaces. XVibe uses **both, for different
jobs, with different credentials**. Do not mix them — each rejects the other's
token with `E_SCOPE`.

| Surface | URL | Credential | Who calls it | For |
|---|---|---|---|---|
| **MCP** (authoring) | `https://pluggie.app/api/mcp` | **mcp-scoped** token | XVibe's **builder agent**, server-side | define the data model, seed content, mint delivery tokens |
| **Delivery** (public) | `https://pluggie.app/api/v1` | **delivery-scoped** token | the **built app** the user ships | read/write published content |

**The mcp token never leaves XVibe's server.** The delivery token is what gets
baked into the generated app's server-side env. Never ship an mcp token to a
browser or a built artifact.

## 2. How the builder agent talks to Pluggie (MCP)

Plain JSON-RPC 2.0 over HTTP POST. **No handshake, no session, no SDK
required** — stateless request/response is a supported pattern.

```ts
async function callTool(name: string, args: unknown) {
  const res = await fetch("https://pluggie.app/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${MCP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await res.json();
  const text = body.result?.content?.[0]?.text ?? "";
  if (body.result?.isError) throw new Error(text);      // errors carry stable E_* codes
  return JSON.parse(text);                               // tools return JSON as text
}
```

- `method: "tools/list"` enumerates the surface (60 tools today).
- A bare `GET` on the same URL is a liveness/identity check and returns the
  error-code registry.
- **Rate limit: 300 tool calls/min/project**, answered structured
  (`E_RATE_LIMITED` + `retryAfterSec`), never bare prose.
- **Re-run `tools/list` if a session is long-lived.** The platform announces
  tool-surface changes through `get_project_info` → `briefing.notices`; a
  cached tool list is how a real field agent spent a night calling tools that
  had shipped hours earlier.

**Orientation call, every session:** `get_project_info` returns the project's
branding, every URL you need (delivery base, admin, changes feed), and a
`briefing` (plugin updates, platform notices, connector health).

## 3. Getting a token — the part that changes

This is the only piece with a "now" and a "soon", and **XVibe can start today
without waiting.**

### 3a. TODAY — manual token (unblocks Phase 1 immediately)

1. In the Pluggie admin: **Settings → Tokens**, mint an **mcp (full)** token.
2. Put it in XVibe's server env: `PLUGGIE_MCP_TOKEN=agx_…`.
3. The builder agent uses it for the target project.

Good enough for the whole first build. One token = one project, so this is a
single-project development setup, which is exactly what Phase 1 needs.

### 3b. SOON — OAuth (D3, in flight on the Pluggie side)

When D3 lands, XVibe becomes a normal **OAuth client** of Pluggie: the user
clicks "Build & deploy", a browser consent names the **workspace + project**,
and XVibe receives a scoped, labeled, expiring token. **No custom handoff
protocol is needed or should be invented** — if you find yourself designing a
token-exchange, stop; that is D3's job.

⚠️ **Design the token as swappable from day one.** Read it from one place
(`getPluggieToken(projectId)`), never inline. Then 3a → 3b is a one-function
change, not a refactor.

### 3c. Tokens for the app XVibe builds

The built app needs a **delivery** token — the builder agent mints it itself:

```
mint_delivery_token { label: "<app name> — production" }
```

Returns the raw token **once** (store it immediately; only a hash is kept), and
names the project it minted on. Handling rules the platform enforces socially
and you must enforce technically: **server-side env only**, never a
`NEXT_PUBLIC_*` var, never committed, never in a client bundle. Companion tools:
`list_delivery_tokens`, `revoke_delivery_token` (rotation = revoke + mint).
Cap: 25 live delivery tokens per project.

## 4. The build loop (what the agent actually does)

1. `get_project_info` — orient; capture `urls.deliveryBase`.
2. `list_collections` / `describe_collection` — see what exists.
3. `list_plugins` → `get_plugin` → `enable_plugin` — compose capabilities
   (`auth_kit`, `booking`, `notification_kit`, `waitlist`, `feedback_wall`,
   `media_gallery`, `seo`). **This is how "add logins" is implemented — you do
   not build auth, you enable and reconcile a plugin.**
4. `define_collection` — realize the model. ⚠️ **Full-replace semantics**: to
   add one field you re-send the whole collection, and an omitted field reads
   as a destructive removal (gated behind `confirm`). Read the current shape
   with `describe_collection` and merge before sending.
5. `create_entry` / `bulk_create_entries` — seed content.
6. `get_client_code` — returns a typed, dependency-free TS client compiled from
   the live schema. **Save it verbatim; regenerate after every schema change.**
7. `mint_delivery_token` — credential for the built app.
8. **`await ax.verifyConnection()`** — run this before writing app code. It
   isolates wrong-base-URL vs bad-token vs stale-client in one call and will
   save you a day. (It exists because a field agent lost one.)

**Read-your-own-writes:** MCP reads are fresh — an agent's own
define/delete is visible on its next call. The **delivery API converges within
~15s** and additionally enforces `publicFilter`, so the two surfaces can
disagree briefly on both timing and row visibility. Mutation results carry a
`convergence` note. Do not build "write over MCP, immediately read over
delivery" flows without accounting for that window.

## 5. Errors

Every error is `{error, code}` with a stable `E_*` code from an append-only
registry (`GET /api/mcp` lists it). Codes are the contract — branch on them,
not on message text. Common ones: `E_VALIDATION` (with a structured
`ConstraintIssue[]`), `E_NOT_FOUND`, `E_SCOPE` (wrong token surface),
`E_CONFIRM_REQUIRED` (a destructive change returned a plan — re-send with
`confirm: true`), `E_RATE_LIMITED`, `E_CONNECTOR_REQUIRED`.

Messages are written to be self-repairing: they state the fix. A 404 on the
delivery API names the project's public collections and the correct path shape.

## 6. Boundary rules (non-negotiable)

1. **No imports from the Pluggie codebase.** HTTP/MCP only. Enforce with
   `no-restricted-imports` on the XVibe folder so it fails in CI, not in review.
2. **No direct database access.** Not to the control DB, not to a tenant DB.
   Every read and write goes through the API.
3. **No tenant code execution** (XVIBE-PLAN §boundary). XVibe serves static
   builds from R2/CDN. The Cloudflare Workers exception is Phase 3, gated.
4. **The mcp token stays server-side.** Always.

## 7. Feedback loop — please use it

`send_feedback` is always available on the MCP surface. When XVibe's agent
hits a platform limitation, **call it** — it lands on the operator's triage
wall and is the mechanism by which Pluggie improves. Bug reports require
`evidence` (the request + the verbatim response); the platform stamps each
report with deterministic verification (claimed codes checked against the
registry, tool names against the surface, platform commit).

Two known-open items XVibe will likely meet, already tracked — no need to
re-report, but say so if they bite harder than expected:
- **No additive field op** on `define_collection` (§4 step 4).
- **Two read planes disagree** — the ~15s delivery convergence + `publicFilter`
  asymmetry (§4).

## 8. Project provisioning — XVibe canNOT create projects today

**Verified 2026-07-25.** There is **no API and no MCP tool** that creates a
Pluggie project. `createProject` exists only as a Clerk-session-gated Next.js
**server action** (`app/admin/new/actions.ts`), and its own comment says
creation *"stays operator-only until B3 attaches billing to this exact seam."*
There is no `create_project` in the 60-tool MCP surface.

**What that means concretely:**

- **Phase 1: the project already exists.** The user creates it in the Pluggie
  admin the normal way, then clicks "Build & deploy" from inside it. **XVibe
  never provisions anything** — it is handed a project id and works in it. This
  is not a limitation to route around; it is the phase boundary.
- **Phase 2 needs this built** (P2.2 in XVIBE-PLAN): "create a project in this
  user's workspace, provision its database, issue a scoped token" + the delete
  path. It is real Pluggie-side work, currently unbuilt, and it lands on the
  same workspace/token machinery as MT-1.
- **Deletion already cascades correctly** — deleting a project wipes its
  content through the FK cascades (verified). So Phase 2's delete path is
  mostly plumbing, not new semantics.

⚠️ **Constraint that will bite in Phase 2 planning:** a workspace gets **one
free sandbox project**; beyond that, projects are paid plans (`byo` /
`managed`). "One XVibe app = one Pluggie project" therefore has a billing
consequence the moment a user builds a second app. Billing is deliberately out
of scope right now (operator decision — no real users yet), but the *shape* of
that decision belongs in Phase 2's design, not after it.

## 9. Sign-in and domains — the cross-domain problem, honestly

**Correction to an earlier claim:** entering XVibe from inside Pluggie does
*not* automatically carry the session if XVibe is on a different domain. Clerk
sessions live in cookies scoped to a domain — a `pluggie.app` session is not
visible to `xvibe.app`. Plan accordingly.

Three ways to resolve it, cheapest first:

| Option | How | Cost | Best for |
|---|---|---|---|
| **A. Same-site subdomain** | serve the studio at `studio.pluggie.app`; cookies scoped to `.pluggie.app` are shared | ~zero auth work | **Phase 1** |
| **B. Clerk satellite domains** | register `xvibe.app` as a satellite of the `pluggie.app` primary — Clerk supports multi-domain apps explicitly | config + some wiring | wanting xvibe.app branding early |
| **C. XVibe's own accounts + OAuth** | XVibe becomes a normal OAuth client of Pluggie (D3); its users are its own | most work, needs D3 | **Phase 2** (standalone front door) |

**Recommendation: A for Phase 1, C for Phase 2.** Option A makes the entire
auth problem disappear while the product is still being proven, and it costs
nothing to move later because the entry point is designed swappable
(XVIBE-PLAN's load-bearing rule). Reach for B only if `xvibe.app` branding is
needed before Phase 2 — it is a real, supported path, just not free.

Note the interaction with §3: **auth (who the human is) and the MCP token (what
the agent may do) are separate problems.** Even in option A, the builder agent
still authenticates to Pluggie with an mcp token server-side. Solving the
domain question does not solve the token question, and vice versa.

## 10. First 30 minutes (suggested)

1. Mint an mcp token on a **throwaway** Pluggie project (not a client project).
2. `POST /api/mcp` with `tools/list` — confirm 60 tools.
3. `get_project_info` — read the briefing.
4. `define_collection` a toy collection, `create_entry` a row.
5. `get_client_code`, then `mint_delivery_token`, then `verifyConnection()`.
6. Read one real read back through the delivery API.

If all six work, the contract in this file is proven end-to-end and you can
build the IDE against a known-good spine.
