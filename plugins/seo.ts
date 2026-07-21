import type { PluginDef } from "@/lib/plugins";

/**
 * SEO agent — first-party BUILT-IN plugin (ships in the app binary).
 * Site-wide audit → scorecard → fix → re-score loop over the `seo` group.
 * Tools (fetch_page / score_page / audit_site) live in lib/seo.ts + the MCP
 * surface; enabling this plugin is what unlocks them (pluginEnabled gate).
 */
export const SEO_PLUGIN: PluginDef = {
  id: "seo",
  provides: "seo_advisor",
  version: "1.1.0",
  name: "SEO agent",
  description:
    "Site-wide audit → scorecard → fix → re-score loop: audit_site (multi-page/sitemap) + fetch_page + score_page, an `seo` group on page-shaped collections, and the operating guidance. Read-only against the site; fixes flow through entries.",
  structure: {
    intent:
      "Every page-shaped collection carries an `seo` group the site's <head> renders from, so " +
      "search/share metadata is CONTENT (auditable, fixable, versioned) instead of hardcoded.",
    baseline: [
      {
        name: "pages",
        displayName: "Pages",
        fields: [
          { name: "title", label: "Title", type: "text", required: true, publicRead: true },
          {
            name: "seo",
            label: "SEO",
            type: "group",
            publicRead: true,
            fields: [
              { name: "title", label: "Meta title", type: "text", max: 70 },
              { name: "description", label: "Meta description", type: "text", max: 200 },
              { name: "canonical", label: "Canonical URL", type: "text" },
              { name: "og_title", label: "OG title", type: "text", max: 100 },
              { name: "og_description", label: "OG description", type: "text", max: 300 },
              { name: "og_image", label: "OG image", type: "asset" },
              { name: "noindex", label: "Hide from search", type: "boolean" },
            ],
          },
        ],
      },
    ],
    reconcile:
      "The `pages` collection here is a REFERENCE — do not create it if the project already has " +
      "page-shaped collections. Instead ADD the `seo` group (define_collection update) to each " +
      "existing collection that renders as a page (pages, posts, products…). Keep the group " +
      "publicRead so the site's head template can read it.",
  },
  tools: ["fetch_page", "score_page", "audit_site"],
  guidance:
    "Operate the loop SITE-WIDE (v2): audit_site with the sitemap (or key urls, max 10) → for " +
    "each page, write its fixes into the matching entry's `seo` group (update_entry — the user " +
    "confirms the fix plan in chat before you write) → the site renders them (its layout reads " +
    "the group via the delivery API, e.g. Next.js generateMetadata) → audit_site again to PROVE " +
    "the scores moved. Findings' `fix` fields name the exact seo.* field to write. Pages are read " +
    "LIVE, so a fix only shows after the site redeploys/revalidates. score_page remains for " +
    "single-URL spot checks.",
  acceptance: [
    "each page-shaped collection carries a publicRead `seo` group with at least title + description",
    "score_page returns a scorecard for the site's key URLs",
    "after writing fixes and the site re-rendering, re-scored pages improve",
  ],
};
