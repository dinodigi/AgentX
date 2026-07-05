# Delivery API versioning discipline

The delivery API lives under `/api/v1`. Client sites are built against it by
agents and then left alone — a breaking change silently breaks a paying
client's production site. This is the rule for what counts as breaking and how
a break would ship.

## Non-breaking (ship freely under /v1)

- New endpoints (e.g. `/uploads` landed in subsystem 06).
- New OPTIONAL query params (`select`, `sort`) — absent params keep old behavior.
- New fields in response bodies (`code` beside `error`; envelope additions).
- New response headers (ETag).
- New field types / constraint knobs — they only affect newly-defined schemas.
- Tightening validation that only rejects requests which previously corrupted
  data or errored differently.

## Breaking (requires /v2)

- Removing or renaming a response field, or changing its type/shape
  (e.g. relations `{id,label}` → something else).
- Changing the meaning of an existing param, status code, or gate
  (e.g. making publicFilter apply to admin reads).
- Requiring a param/header that was optional.
- Changing the error envelope shape (codes are append-only, like the registry).

## How /v2 would ship (when ever needed)

1. `/api/v2` mounts NEW route handlers; `/api/v1` handlers stay untouched and
   frozen — shared lib code may evolve only behind v1-compatible adapters.
2. `get_project_info` advertises both bases with a deprecation note; the
   generated client (get_client_code) targets v2 from that day.
3. v1 sunset only when the platform can prove (usage metering, subsystem 01)
   that no project has hit it for a full billing period — never on a calendar.

## Practical guardrails

- The smoke suite is the compatibility contract: suites 03/04 (delivery
  projection, gates, filters) pin v1 behavior. A change that forces editing an
  existing delivery assertion is a breaking-change smell — stop and reread
  this doc.
- Generated clients embed the schema snapshot, not the API version; they
  regenerate freely. Hand-written site code is the thing v1 protects.
