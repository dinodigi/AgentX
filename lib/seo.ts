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

/** Attribute-order-tolerant head extraction — regex heuristics, not a DOM. */
function parseHead(html: string): Omit<PageHead, "url" | "status"> {
  const head = html.slice(0, html.search(/<\/head>/i) === -1 ? html.length : html.search(/<\/head>/i));
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const attr = (tag: string, name: string): string | null => {
    // Leading boundary so e.g. data-name= can never satisfy name=.
    const m = tag.match(new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    return m ? (m[2] ?? m[3] ?? null) : null;
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
    title: head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null,
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
