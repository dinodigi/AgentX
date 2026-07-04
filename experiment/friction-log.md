# Friction log — Arm A (Tidewater with MCP), run of 2026-07-04

Feeds ROADMAP.md Phase 2.4. Each entry: what happened, cost, proposed fix.

## F1 — Agent cannot discover the delivery API (severity: high)

Observed ~10 min in: agent probed likely endpoints, then resorted to reading
the AgentX source tree on disk to learn `/api/v1/{collection}` and its auth.
The MCP tool surface never states where the delivery API is or its shape; the
generated API reference lives behind Clerk where agents can't see it.

**Fix:** `get_project_info` tool returning delivery base URL, endpoint shape,
filter/sort syntax, admin URL, branding. Also mention the delivery API in the
`define_collection` / `query_entries` tool descriptions ("public fields are
served at GET {base}/api/v1/{name}").

## F2 — Delivery API returns bare asset ids (severity: defect)

Agent found that public reads return asset fields as raw uuids with no public
resolution to a URL. A site cannot render images from the delivery API at all.
Relations resolve to {id, label}; assets don't resolve to anything.

**Fix:** resolve asset fields to {id, url} in delivery responses (and in
query_entries), same pattern as relation resolution — one batched lookup.
Watch for the agent's workaround: storing upload_asset's returned URL in a
text field. If it does that, F2 is confirmed as blocking, not just annoying.

## (running notes — add during the run)

-
