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

**CONFIRMED post-run:** agent created DUAL fields on both guides and trips —
private `asset` field for admin uploads + public `_url` text field for
delivery. Schema pollution to route around the defect. F2 is blocking.

## Post-run scoring notes (2026-07-04)

- Privacy: Arm A scored 8/8 with zero effort — per-field publicRead made the
  brief's privacy requirements the default behavior. BUT Arm B (from scratch)
  ALSO scored 8/8 — a careful agent builds this correctly anyway. Privacy is a
  "harder to get wrong" advantage, not a unique capability.
- Code volume: Arm A 974 lines / 12 files (site only). Arm B 2,899 lines /
  43 files (site + sqlite layer + hand-rolled HMAC auth + admin + webhook
  module). ~2,000 lines ≈ the surface AgentX absorbs — and must keep absorbing
  well, because that's the pitch.
- Row-level visibility: pending testimonials publicly fetchable in Arm A via
  ?approved=true on a public field (predicted). Arm B avoided this trivially —
  its SQL just WHERE-filters. Evidence FOR Phase 4.
- delete/list asset gap didn't block; filters/sort got real use on /trips
  (both difficulty filter + price sort hit the delivery API).
