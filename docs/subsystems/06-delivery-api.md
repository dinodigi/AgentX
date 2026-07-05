# 06 · Delivery API (grade B+)

Purpose: what live sites consume. Projection, row gates, identity, and owner
endpoints exist; the gaps are file intake and web-native behavior.

## Sub-features

- [ ] **Public uploads** (M) — a size/type-limited upload path usable by
      publicWrite forms ("attach a photo to your booking"). Enforces 02's
      limits; returns an asset id the form submission references. Consider
      presigned-PUT to R2 to keep bytes off our server.
- [ ] **HTTP caching** (S) — ETag/Last-Modified on GET; correct 304s. Cheap
      and makes CDN-fronting effective at deploy time.
- [ ] **Consistent error envelope** (S) — same {error, code} shape everywhere,
      aligned with 03's error registry.
- [ ] **Preflight correctness** (S) — OPTIONS handling tied to 02's CORS work.
- [ ] **API version discipline doc** (S) — /v1 exists; write the rule for what
      counts as breaking and how /v2 would ship.

Done when: a static site on a CDN can render, filter, submit forms with
attachments, and let signed-in users manage their own records — with no
server of its own.
