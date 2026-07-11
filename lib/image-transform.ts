import sharp from "sharp";
import { z } from "zod";
import { objectExists, getObjectBytes, putObject, listPrefixKeys, type ProjectStorage } from "./r2";
import { rateLimit } from "./ratelimit";
import { ValidationError } from "./validation";

/**
 * On-demand image transforms (J1). GET /v1/assets/{id}/image?w=&h=&fit=&format=
 * resizes the original and caches the derivative in R2, then 302s to its public
 * URL. Abuse bounds are durable: dimensions snap to a fixed ladder (bounded key
 * space), a per-asset derivative budget caps distinct variants, and per-IP rate
 * limits throttle generation. SVG is refused upstream (it reaches sharp's XML
 * decoder — a raster-only surface).
 */

// Width/height snap UP to the nearest ladder value — bounds the derivative key
// space to 12 sizes/dim (24 single-dim + 288 both-dim) × 2 formats = 624/asset.
const LADDER = [64, 96, 128, 256, 320, 480, 640, 768, 960, 1200, 1600, 2000] as const;
const MIN_DIM = 16;
const MAX_DIM = 2000;

/** Max distinct derivatives cached per asset before we refuse new variants. */
export const DERIVATIVE_BUDGET = 40;

const QUALITY = { webp: 80, jpeg: 82 } as const;

function snapUp(v: number): number {
  const clamped = Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(v)));
  return LADDER.find((l) => l >= clamped) ?? LADDER[LADDER.length - 1];
}

const dimSchema = z.coerce.number().int().min(MIN_DIM).max(MAX_DIM).optional();

const rawParamSchema = z
  .object({
    w: dimSchema,
    h: dimSchema,
    format: z.enum(["webp", "jpeg"]).default("webp"),
    fit: z.enum(["cover", "inside"]).optional(),
  })
  .strict();

export interface TransformParams {
  w?: number;
  h?: number;
  format: "webp" | "jpeg";
  fit: "cover" | "inside";
}

/** Parse + normalize query params, or throw ValidationError (→ 422). */
export function parseTransformParams(query: Record<string, string>): TransformParams {
  let parsed;
  try {
    parsed = rawParamSchema.parse(query);
  } catch {
    throw new ValidationError(
      `bad image params — w/h are ints ${MIN_DIM}..${MAX_DIM} (snapped to ${LADDER.join(",")}), format webp|jpeg, fit cover|inside`,
    );
  }
  if (parsed.w === undefined && parsed.h === undefined) {
    throw new ValidationError("image transform needs at least one of w or h");
  }
  if (parsed.fit && (parsed.w === undefined || parsed.h === undefined)) {
    throw new ValidationError('fit (cover|inside) applies only when BOTH w and h are given — drop fit, or pass both dims');
  }
  return {
    w: parsed.w !== undefined ? snapUp(parsed.w) : undefined,
    h: parsed.h !== undefined ? snapUp(parsed.h) : undefined,
    format: parsed.format,
    fit: parsed.fit ?? "cover",
  };
}

const dirname = (key: string): string => key.slice(0, key.lastIndexOf("/"));

/** Canonical R2 key for a derivative, under the asset dir's `_t/` prefix. */
export function derivedKey(r2Key: string, p: TransformParams): string {
  const base = `${dirname(r2Key)}/_t`;
  const ext = p.format;
  if (p.w !== undefined && p.h !== undefined) return `${base}/w${p.w}h${p.h}-${p.fit}.${ext}`;
  if (p.w !== undefined) return `${base}/w${p.w}.${ext}`;
  return `${base}/h${p.h}.${ext}`;
}

/**
 * True only if the bytes START with a known RASTER magic number. sharp sniffs
 * format from CONTENT (not the declared contentType), so a payload uploaded as
 * image/jpeg but holding SVG/XML would still reach sharp's librsvg decoder — a
 * public-endpoint SSRF/bomb surface. This checks the actual bytes and refuses
 * anything that isn't jpeg/png/gif/webp/tiff/heif-avif.
 */
export function looksLikeRaster(b: Buffer): boolean {
  if (b.length < 12) return false;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true; // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return true; // WEBP (RIFF....WEBP)
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
    return true; // TIFF
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true; // HEIF/AVIF ftyp
  return false;
}

export type EnsureResult =
  | { ok: true; key: string }
  | { ok: false; status: 429 | 422; error: string; retryAfterSec?: number };

/**
 * Ensure the derivative exists in the PROJECT'S storage plane (A4), returning
 * its key. On a cache miss: enforce the per-asset budget, then per-IP rate
 * limits, then generate with sharp and store. Idempotent — a concurrent
 * generate just re-writes the same deterministic key.
 */
export async function ensureDerivative(
  st: ProjectStorage,
  asset: { r2Key: string },
  params: TransformParams,
  ip: string,
): Promise<EnsureResult> {
  const key = derivedKey(asset.r2Key, params);
  if (await objectExists(st, key)) return { ok: true, key };

  // Budget: cap distinct derivatives per asset (bounds R2 cost + abuse).
  const existing = await listPrefixKeys(st, `${dirname(asset.r2Key)}/_t/`);
  if (existing.length >= DERIVATIVE_BUDGET && !existing.includes(key)) {
    return {
      ok: false,
      status: 429,
      error: `derivative budget reached (${DERIVATIVE_BUDGET}/asset) — reuse an existing variant`,
    };
  }

  // Rate-limit generation per IP (global) and per asset+IP (hot-asset abuse).
  for (const k of [`img:${ip}`, `img:${asset.r2Key}:${ip}`]) {
    const rl = await rateLimit(k);
    if (!rl.allowed) {
      return { ok: false, status: 429, error: "too many image transforms — try again shortly", retryAfterSec: rl.retryAfterSec };
    }
  }

  const original = await getObjectBytes(st, asset.r2Key);
  // Content sniff (not the declared contentType): refuse SVG/XML/polyglots that
  // would otherwise reach sharp's librsvg decoder.
  if (!looksLikeRaster(original)) {
    return { ok: false, status: 422, error: "asset is not a supported raster image (jpeg/png/gif/webp/tiff/avif)" };
  }
  let pipeline = sharp(original, { limitInputPixels: 100_000_000, failOn: "error" }).rotate();
  pipeline = pipeline.resize({
    width: params.w,
    height: params.h,
    fit: params.w !== undefined && params.h !== undefined ? params.fit : undefined,
    withoutEnlargement: true,
  });
  const body =
    params.format === "webp"
      ? await pipeline.webp({ quality: QUALITY.webp }).toBuffer()
      : await pipeline.jpeg({ quality: QUALITY.jpeg }).toBuffer();

  await putObject(st, key, body, `image/${params.format}`);
  return { ok: true, key };
}

/** SVG reaches sharp's librsvg/XML path — refuse it (and any non-raster). */
export function isTransformable(contentType: string): boolean {
  return contentType.startsWith("image/") && contentType !== "image/svg+xml";
}
