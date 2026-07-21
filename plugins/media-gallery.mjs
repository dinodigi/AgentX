/**
 * Media Gallery — base plugin (wave 1). Requested twice in the field (venue
 * photo seeding; site gallery arrays): albums of images served publicly with
 * publish gating, built for the token-cheap upload-by-URL path.
 * One capability: `media_gallery`.
 */
export const MEDIA_GALLERY_PLUGIN = {
  id: "media_gallery",
  version: "1.0.0",
  provides: "media_gallery",
  name: "Media Gallery — publishable image albums",
  description:
    "Albums with cover + image arrays, slugified URLs, and publish gating: unpublished galleries " +
    "are invisible on the delivery API. Seed images by URL (no token-burning base64) and serve " +
    "thumbnails via the built-in image transforms.",
  structure: {
    intent:
      "Give a site publishable image albums: create a gallery, fill its image array (upload by " +
      "URL), flip published — the delivery API serves exactly the published ones, with on-demand " +
      "thumbnail transforms.",
    baseline: [
      {
        name: "galleries",
        displayName: "Galleries",
        publicFilter: [{ field: "published", op: "eq", value: true }],
        fields: [
          { name: "title", label: "Title", type: "text", required: true, max: 200, searchable: true, publicRead: true },
          { name: "slug", label: "Slug", type: "text", unique: true, publicRead: true,
            computed: { fn: "slugify", from: "title" } },
          { name: "description", label: "Description", type: "text", max: 2000, publicRead: true },
          { name: "cover", label: "Cover", type: "asset", publicRead: true },
          { name: "images", label: "Images", type: "array", item: { type: "asset" }, maxItems: 100, publicRead: true },
          { name: "published", label: "Published", type: "boolean", indexed: true },
          { name: "sort_order", label: "Sort order", type: "number", indexed: true },
        ],
      },
    ],
    reconcile:
      "If a galleries/albums collection exists, EXTEND it (publicFilter on published is the load-" +
      "bearing part — never serve drafts). Seed images with upload_asset {url} — one call per " +
      "image, bytes never enter your context — then reference the returned ids in `images`. The " +
      "site lists via GET /api/v1/galleries (?sort=sort_order:asc) and renders thumbnails via " +
      "GET /api/v1/assets/{id}/image?w=480.",
  },
  tools: [],
  guidance:
    "You are managing image galleries. SEED: upload_asset {url: <https source>, filename} per " +
    "image (NEVER inline base64 for bulk — the url path costs zero context), collect the ids into " +
    "galleries.images, set cover, keep published:false while drafting. PUBLISH = set " +
    "published:true — the delivery publicFilter serves ONLY published galleries; drafts are " +
    "invisible, not just unlisted. Reads resolve assets to {id,url,contentType}; a read→modify→" +
    "write round-trip of the images array is safe (objects coerce back to ids). THUMBNAILS: " +
    "/api/v1/assets/{id}/image?w=480&format=webp — 1-year-immutable, CDN-friendly. ORDER: " +
    "sort_order ascending; reorder by rewriting the array (within a gallery) or sort_order " +
    "(across galleries).",
  acceptance: [
    "the collection exists with slug computed from title and a unique constraint",
    "an unpublished gallery is INVISIBLE on GET /api/v1/galleries; publishing makes it appear",
    "images seed via upload_asset {url} and the array round-trips through query→update unchanged",
    "thumbnail transforms serve for gallery images",
  ],
};
