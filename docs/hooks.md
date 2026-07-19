# Before-write hooks

> **Contract — stable since 2026-07-09.** Update only when the hook envelope
> or signing scheme changes.

A before-write hook is a **signed, synchronous POST** from AgentX to *your*
endpoint that gates (and optionally rewrites) an entry write before it commits.
AgentX never hosts or evaluates your code — it calls yours. Declare one per
stage on a collection:

```jsonc
// define_collection … hooks:
{
  "beforeCreate": { "url": "https://you.example.com/agentx/hook", "mode": "validate" },
  "beforeUpdate": { "url": "https://you.example.com/agentx/hook", "mode": "transform", "onError": "allow", "timeoutMs": 2000 }
}
```

- `mode: "validate"` — only allow/reject the write. `mode: "transform"` — return the
  full new entry to write instead (**https-only**, loopback excepted).
- `onError: "reject"` (default, fail-closed) blocks the write when your endpoint is
  unreachable/times out/answers malformed; `"allow"` fails open.
- `timeoutMs` 500–5000 (default 3000). `when: [clauses]` gates the call by the candidate.
- Requires the project's **webhook signing secret** (project settings) — the request is
  signed so you can authenticate that it's really AgentX.

## Request

`POST <your url>` with headers:

| Header | Value |
| --- | --- |
| `content-type` | `application/json` |
| `x-agentx-signature` | `t=<unix>,v1=<hex hmac>` (same scheme as event webhooks) |
| `x-agentx-hook` | `1` — a marker; use it to break write-back loops (see below) |

Body (`entry.before_update` also includes `current`; `candidate.data` on update is the
**merged** post-patch row):

```json
{ "event": "entry.before_create", "collection": "orders", "candidate": { "data": { "total": 42 } } }
```

## Verify the signature (Node)

Identical scheme to AgentX's outbound event webhooks. Read the **raw** body before parsing.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(parts.v1 ?? "", "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

## Response contract

Reply `200` with JSON:

- **Allow:** `{ "ok": true }`
- **Reject:** `{ "ok": false, "error": "human reason" }` → the write fails with
  `E_HOOK_REJECTED` (422) carrying your reason.
- **Transform** (mode `transform` only): `{ "ok": true, "data": { …full entry… } }`.
  AgentX re-validates your `data` exactly like client input and **always** re-stamps/
  preserves ownership (`ownerField`/`org`) and computed fields — a hook can never move
  ownership or set a computed value. Return the FULL entry; omitted keys are unset.

A non-`{ok}` body, a non-2xx-shaped answer, or no answer within `timeoutMs` is an
*outage* → `onError` decides (fail-closed `E_HOOK_FAILED` 502, or fail-open).

## Write-back & loop avoidance

Your endpoint may write results back to AgentX (delivery API or MCP). To stay
idempotent under retries, use `idempotencyKey` on create/transact or
`update_entry_if` (CAS). If your write-back targets a **hooked** collection, guard
against re-entry: skip your own hook logic when the incoming request carries
`x-agentx-hook: 1`, or write to a different collection.

## Boundaries

Hooks are **synchronous + gating**. For async side-effects use collection **events**
(webhooks/emails, fire-and-forget). Both are consulted from the entries write choke
point, so MCP, admin, and delivery writes inherit them identically. `update_entry_if`
(CAS) and hooks-disabled paths never call your endpoint. Dry-run with the `test_hook`
MCP tool before pointing production writes at your endpoint.
