/**
 * Shipped cap DEFAULTS (B2/Track 4a) — plain constants with no server deps so
 * both lib/caps.ts (enforcement) and lib/platform-settings.ts (operator
 * overrides) can share them without an import cycle. The EFFECTIVE caps are
 * defaults + the console's Platform Settings overrides — read via
 * effectiveCaps(), never these directly, on any enforcement path.
 */
export const SANDBOX_CAPS = {
  entries: 1_000,
  collections: 20,
  assetBytes: 100 * 1024 * 1024, // 100 MB
  // Total stored JSONB (post-TOAST, what Neon storage actually costs). The
  // entries cap bounds row COUNT; this bounds row FAT — 1k entries × 1 MiB
  // bodies would otherwise be a 1 GB free sandbox.
  dataBytes: 50 * 1024 * 1024, // 50 MB
} as const;

export const PAID_CAPS = {
  entries: 250_000,
  collections: 500,
  assetBytes: 25 * 1024 * 1024 * 1024, // 25 GB
  dataBytes: 5 * 1024 * 1024 * 1024, // 5 GB
} as const;
