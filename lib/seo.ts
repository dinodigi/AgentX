import "server-only";
import { guardedFetch, webhookTargetRefusal } from "./net-guard";

/**
 * SEO plugin (Track 3) — the tool half. fetchPageHead crawls ONE live page's
 * <head> (SSRF-guarded exactly like webhooks: shape check + private-range
 * refusal + redirect revalidation, bounded read); scoreHead turns it into an
 * evidence-based scorecard whose findings map to the `seo` group fields the
 * plugin's structure adds — so "fix" always means "write this entry field".
 * Advisor v1: read-only against the live site; fixes flow through update_entry.
 */

const HEAD_READ_CAP = 512 * 1024; // the <head> lives in the first bytes; cap the read
const FETCH_TIMEOUT_MS = 10_000;

export interface PageHead {
  url: string;
  status: number;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  h1Count: number;
  htmlLang: string | null;
  hasViewport: boolean;
  hasJsonLd: boolean;
  robots: string | null;
}

export async function fetchPageHead(rawUrl: string): Promise<PageHead> {
  const refusal = await webhookTargetRefusal(rawUrl);
  if (refusal) throw new Error(`page ${refusal}`);
  const res = await guardedFetch(rawUrl, {
    headers: { "user-agent": "PluggieSEO/1.0 (+https://pluggie.app)", accept: "text/html" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // Dogfood finding: a cold-starting origin once got its 503 placeholder page
  // GRADED (a misleading 44/100). Non-200 pages are never scored.
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`page returned HTTP ${res.status} — not scored; retry when the site is serving normally`);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`not an HTML page (content-type ${type || "unknown"})`);
  }
  const html = await readCapped(res, HEAD_READ_CAP);
  return { url: rawUrl, status: res.status, ...parseHead(html) };
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= cap) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8", 0, Math.min(total, cap));
}

/**
 * HTML entities → the text a human and a search engine actually see.
 *
 * Field report (Stallion, 2026-07-20): a 60-char title containing two `&`
 * measured as 68 and got dinged for being too long — we were counting the
 * SOURCE, not the rendered string. Lengths, and the `found:` text we hand back,
 * must both be on decoded text. It also fixes `&amp;` inside canonical/og:image
 * URLs, which is how a correctly-escaped query string appears in markup.
 *
 * ONE pass, deliberately: a decode-then-decode-again approach would turn the
 * correctly-escaped `&amp;lt;` into `<`. Unknown named entities are left
 * verbatim rather than guessed at.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    const code =
      body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    // Reject non-scalar values (lone surrogates would throw fromCodePoint).
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
    if (code >= 0xd800 && code <= 0xdfff) return whole;
    return String.fromCodePoint(code);
  });
}

/** Attribute-order-tolerant head extraction — regex heuristics, not a DOM. */
function parseHead(html: string): Omit<PageHead, "url" | "status"> {
  const head = html.slice(0, html.search(/<\/head>/i) === -1 ? html.length : html.search(/<\/head>/i));
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const attr = (tag: string, name: string): string | null => {
    // Leading boundary so e.g. data-name= can never satisfy name=.
    const m = tag.match(new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    const raw = m ? (m[2] ?? m[3] ?? null) : null;
    // Decode HERE so every attribute-sourced value (descriptions, og:*, and the
    // canonical/og:image URLs) is measured and reported as rendered text.
    return raw === null ? null : decodeEntities(raw);
  };
  const metaBy = (key: "name" | "property", value: string): string | null => {
    for (const m of metas) {
      if ((attr(m, key) ?? "").toLowerCase() === value) return attr(m, "content");
    }
    return null;
  };
  const canonical =
    links.map((l) => ((attr(l, "rel") ?? "").toLowerCase() === "canonical" ? attr(l, "href") : null)).find(Boolean) ??
    null;
  return {
    // Decode BEFORE trim — trim() also strips a decoded &nbsp; at the edges.
    title: (() => {
      const raw = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
      return raw === undefined ? null : decodeEntities(raw).trim();
    })(),
    metaDescription: metaBy("name", "description"),
    canonical,
    ogTitle: metaBy("property", "og:title"),
    ogDescription: metaBy("property", "og:description"),
    ogImage: metaBy("property", "og:image"),
    h1Count: (html.match(/<h1[\s>]/gi) ?? []).length,
    htmlLang: attr(html.match(/<html\b[^>]*>/i)?.[0] ?? "", "lang"),
    hasViewport: metaBy("name", "viewport") !== null,
    hasJsonLd: /<script[^>]*type\s*=\s*("|')application\/ld\+json\1/i.test(html),
    robots: metaBy("name", "robots"),
  };
}

const MAX_AUDIT_PAGES = 10;
const SITEMAP_READ_CAP = 256 * 1024;

/** Bounded sitemap read: the first MAX_AUDIT_PAGES <loc> URLs, SSRF-guarded. */
export async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  const refusal = await webhookTargetRefusal(sitemapUrl);
  if (refusal) throw new Error(`sitemap ${refusal}`);
  const res = await guardedFetch(sitemapUrl, {
    headers: { "user-agent": "PluggieSEO/1.0 (+https://pluggie.app)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`sitemap returned HTTP ${res.status}`);
  }
  const xml = await readCapped(res, SITEMAP_READ_CAP);
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  if (urls.length === 0) throw new Error("no <loc> entries found — is this a sitemap.xml?");
  return urls.slice(0, MAX_AUDIT_PAGES);
}

export interface SiteAuditPage {
  url: string;
  score?: number;
  findings?: SeoFinding[];
  error?: string;
}

/**
 * v2 operator loop, site-wide: score up to MAX_AUDIT_PAGES URLs (explicit list
 * or a sitemap) sequentially — each fetch SSRF-guarded + bounded; one dead
 * page becomes a per-page error, never a failed audit.
 */
export async function auditSite(opts: { urls?: string[]; sitemapUrl?: string }): Promise<{
  pages: SiteAuditPage[];
  summary: { audited: number; failed: number; averageScore: number | null; worst: string | null };
}> {
  let urls = (opts.urls ?? []).slice(0, MAX_AUDIT_PAGES);
  if (urls.length === 0 && opts.sitemapUrl) urls = await fetchSitemapUrls(opts.sitemapUrl);
  if (urls.length === 0) throw new Error("provide urls[] or a sitemapUrl");

  const pages: SiteAuditPage[] = [];
  for (const url of urls) {
    try {
      const head = await fetchPageHead(url);
      const { score, findings } = scoreHead(head);
      pages.push({ url, score, findings });
    } catch (e) {
      pages.push({ url, error: e instanceof Error ? e.message : "fetch failed" });
    }
  }
  const scored = pages.filter((p) => typeof p.score === "number");
  const worst = scored.length > 0 ? scored.reduce((a, b) => (a.score! <= b.score! ? a : b)).url : null;
  return {
    pages,
    summary: {
      audited: scored.length,
      failed: pages.length - scored.length,
      averageScore: scored.length > 0 ? Math.round(scored.reduce((s, p) => s + p.score!, 0) / scored.length) : null,
      worst,
    },
  };
}

export interface SeoFinding {
  check: string;
  severity: "critical" | "warn" | "info";
  found: string;
  /** Actionable, entry-field-shaped fix — what to write into the seo group. */
  fix: string;
}

export function scoreHead(h: PageHead): { score: number; findings: SeoFinding[] } {
  const findings: SeoFinding[] = [];
  let score = 100;
  const ding = (n: number, f: SeoFinding) => {
    score -= n;
    findings.push(f);
  };

  if (h.robots && /noindex/i.test(h.robots)) {
    ding(20, {
      check: "robots",
      severity: "critical",
      found: `meta robots is "${h.robots}"`,
      fix: "the page is BLOCKED from indexing — if unintended, clear seo.noindex / the robots meta",
    });
  }
  if (!h.title) {
    ding(15, { check: "title", severity: "critical", found: "no <title>", fix: "set seo.title (15–60 chars)" });
  } else if (h.title.length < 15 || h.title.length > 60) {
    ding(5, {
      check: "title",
      severity: "warn",
      found: `title is ${h.title.length} chars`,
      fix: "tune seo.title to 15–60 chars (keyword first, brand last)",
    });
  }
  if (!h.metaDescription) {
    ding(15, {
      check: "description",
      severity: "critical",
      found: "no meta description",
      fix: "set seo.description (50–160 chars, a compelling snippet)",
    });
  } else if (h.metaDescription.length < 50 || h.metaDescription.length > 160) {
    ding(5, {
      check: "description",
      severity: "warn",
      found: `description is ${h.metaDescription.length} chars`,
      fix: "tune seo.description to 50–160 chars",
    });
  }
  if (!h.canonical) {
    ding(8, { check: "canonical", severity: "warn", found: "no canonical link", fix: "set seo.canonical to the page's canonical URL" });
  }
  if (!h.ogTitle) ding(5, { check: "og:title", severity: "warn", found: "missing", fix: "set seo.og_title (or default it to seo.title)" });
  if (!h.ogDescription) ding(5, { check: "og:description", severity: "warn", found: "missing", fix: "set seo.og_description" });
  if (!h.ogImage) ding(8, { check: "og:image", severity: "warn", found: "missing", fix: "set seo.og_image (1200×630 share card)" });
  if (h.h1Count === 0) {
    ding(8, { check: "h1", severity: "warn", found: "no <h1>", fix: "the page body needs exactly one h1 (the title/hero heading)" });
  } else if (h.h1Count > 1) {
    ding(4, { check: "h1", severity: "info", found: `${h.h1Count} <h1> tags`, fix: "keep exactly one h1; demote the rest to h2" });
  }
  if (!h.htmlLang) ding(5, { check: "lang", severity: "info", found: "no <html lang>", fix: "set the html lang attribute in the site layout" });
  if (!h.hasViewport) ding(5, { check: "viewport", severity: "warn", found: "no viewport meta", fix: "add the responsive viewport meta in the site layout" });
  if (!h.hasJsonLd) ding(7, { check: "structured-data", severity: "info", found: "no JSON-LD", fix: "emit JSON-LD from the entry (e.g. Article/LocalBusiness) in the site layout" });

  return { score: Math.max(0, score), findings };
}
