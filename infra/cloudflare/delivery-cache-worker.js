/**
 * Pluggie delivery edge cache — Cloudflare Worker.
 *
 * WHY A WORKER (and not plain CDN caching): every delivery read is
 * Bearer-token authenticated and the URL does NOT identify the project — the
 * token does. The same URL (/api/v1/posts) serves DIFFERENT tenants' data
 * depending on the token, so a URL-keyed cache would leak content across
 * tenants. This worker keys the cache by URL + SHA-256(authorization) — one
 * cache slot per tenant per URL — and only stores responses the origin
 * explicitly marked shareable (Cache-Control: s-maxage, emitted by
 * lib/delivery-http.ts cachedJson({share:true}) for public reads only).
 *
 * Deploy: Cloudflare dashboard → Workers → create → paste this file.
 * Route:  <your-host>/api/v1/*   (delivery API ONLY — never /api/mcp or admin)
 * See docs/CDN-SETUP.md for the full setup + verification steps.
 */

export default {
  async fetch(request, env, ctx) {
    // Only GETs are cacheable; everything else passes straight through.
    if (request.method !== "GET") return fetch(request);

    const auth = request.headers.get("authorization");
    // No token → origin 401s (don't cache errors). x-user-token → the response
    // is user-scoped (owner rows, identity-dependent refs) → never shared.
    if (!auth || request.headers.get("x-user-token") !== null) return fetch(request);

    const url = new URL(request.url);
    // Belt-and-suspenders: the route pattern should already restrict us here.
    if (!url.pathname.startsWith("/api/v1/")) return fetch(request);

    // Per-tenant cache key: hash of the bearer token folded into a synthetic
    // query param. The raw token never appears in any key or log.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth));
    const tenant = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const keyUrl = new URL(url);
    keyUrl.searchParams.set("__tenant", tenant);
    const cacheKey = new Request(keyUrl.toString(), { method: "GET" });

    const cache = caches.default;
    const inm = request.headers.get("if-none-match");

    const hit = await cache.match(cacheKey);
    if (hit) {
      // Serve 304s AT the edge: the client's conditional never reaches origin.
      const etag = hit.headers.get("etag") ?? "";
      if (inm && etag && inm.includes(etag.replaceAll('"', ""))) {
        const h = new Headers(hit.headers);
        h.set("x-edge-cache", "HIT");
        return new Response(null, { status: 304, headers: h });
      }
      const resp = new Response(hit.body, hit);
      resp.headers.set("x-edge-cache", "HIT");
      return resp;
    }

    // Fill: request a FULL 200 from origin (strip the client's conditionals so
    // we never cache a bodyless 304).
    const originHeaders = new Headers(request.headers);
    originHeaders.delete("if-none-match");
    originHeaders.delete("if-modified-since");
    const originResp = await fetch(new Request(url.toString(), { method: "GET", headers: originHeaders }));

    // Store ONLY what origin explicitly marked shareable. Errors, user-scoped
    // (private/no-store), and plain no-cache responses are never stored.
    const cc = originResp.headers.get("cache-control") ?? "";
    const storable =
      originResp.status === 200 && /s-maxage=[1-9]/.test(cc) && !/\b(private|no-store)\b/.test(cc);
    if (storable) {
      const clone = originResp.clone();
      const store = new Response(clone.body, clone);
      // The key already encodes the tenant; a Vary header on the stored copy
      // would only defeat cache.match (the synthetic key request carries no
      // authorization header).
      store.headers.delete("vary");
      ctx.waitUntil(cache.put(cacheKey, store));
    }

    // Honor the client's conditional against the fresh body.
    const etag = originResp.headers.get("etag") ?? "";
    if (inm && etag && inm.includes(etag.replaceAll('"', ""))) {
      const h = new Headers(originResp.headers);
      h.set("x-edge-cache", storable ? "MISS-STORED" : "MISS");
      return new Response(null, { status: 304, headers: h });
    }
    const resp = new Response(originResp.body, originResp);
    resp.headers.set("x-edge-cache", storable ? "MISS-STORED" : "MISS");
    return resp;
  },
};
