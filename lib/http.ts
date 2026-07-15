import type { NextRequest } from "next/server";

/**
 * Delivery + MCP JSON bodies are small in practice (the largest legit case is a
 * richtext entry). An unbounded `req.json()` on the shared instance lets one
 * oversized body balloon 5–10× through JSON.parse and OOM the whole Node process
 * — taking every project down until Render restarts it (scorecard D3). Cap the
 * read BEFORE parsing. Mirrors the bounded read the Stripe webhook already uses.
 */
export const MAX_DELIVERY_BODY_BYTES = 1 << 20; // 1 MiB

/**
 * The MCP surface is authenticated (operator token) and legitimately larger —
 * bulk create takes up to 100 entries, transact up to 25 ops, and `upload_asset`
 * carries the file inline as base64 (a 10 MiB asset ≈ 13.3 MiB of JSON). The cap
 * must clear a max-size base64 upload so the upload handler's own size check runs
 * and returns its "too large" error, rather than this cap pre-empting it. Still
 * well below the ~35 MB body that OOMed the instance.
 */
export const MAX_MCP_BODY_BYTES = 16 << 20; // 16 MiB

/**
 * Read a request body up to `max` bytes. Returns the decoded string, or `null`
 * if the body declares (honest content-length) or streams past the cap — the
 * caller maps `null` to a 413 and never lets an oversized body reach JSON.parse.
 */
export async function readBounded(req: NextRequest, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null; // honest-header fast reject
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      // Chunked / lying client: stop before buffering any more.
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
