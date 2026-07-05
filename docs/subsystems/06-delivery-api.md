# 06 · Delivery API ✅ DONE 2026-07-05

Purpose: what live sites consume. A static site on a CDN can now render,
filter, submit forms with attachments, and revalidate cheaply.

## Sub-features

- [x] **Public uploads** (M) — POST /v1/{collection}/uploads (multipart),
      gated like a form submission + requires an asset field; 02's size/type
      limits at the choke point; returns {id,url} the submission references.
      Generated client grows upload(). (Presigned-PUT to R2 deferred until
      upload volume demands it.)
- [x] **HTTP caching** (S) — strong ETags + cache-control: no-cache on list
      and single GETs; If-None-Match → CORS-complete 304.
- [x] **Consistent error envelope** (S) — every /v1 error is {error, code}
      via lib/delivery-http (codes from 03's registry + E_AUTH,
      E_RATE_LIMITED); AgentXError in generated clients carries .code.
- [x] **Preflight correctness** (S) — verified complete from 02; added
      expose-headers (etag, retry-after) + if-none-match to allow-headers.
- [x] **API version discipline doc** (S) — docs/runbooks/api-versioning.md
      (breaking vs safe, how /v2 ships, suite-as-contract guardrail).

Done when: a static site on a CDN can render, filter, submit forms with
attachments, and let signed-in users manage their own records — with no
server of its own.
