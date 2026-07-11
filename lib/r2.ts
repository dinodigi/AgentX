import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { tenantDb } from "./data-plane";
import { assets, entries, entriesTrash, type Asset } from "@/db/schema";
import { ValidationError } from "./validation";

/**
 * Cloudflare R2 via the S3-compatible API. One bucket, keys namespaced per
 * project. Bytes live in R2; metadata lives in the `assets` table. `asset`
 * fields on entries store an asset id.
 */

let _client: S3Client | null = null;
function client(): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return _client;
}

export interface UploadInput {
  projectId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPE_PREFIXES = ["image/", "application/pdf", "text/plain", "text/csv", "application/json"];

export async function uploadAsset(input: UploadInput): Promise<Asset> {
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `file too large: ${input.bytes.length} bytes (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`,
    );
  }
  if (!ALLOWED_TYPE_PREFIXES.some((p) => input.contentType.startsWith(p))) {
    throw new ValidationError(
      `content type "${input.contentType}" not allowed — allowed: ${ALLOWED_TYPE_PREFIXES.join(", ")}`,
    );
  }
  const key = `${input.projectId}/${randomUUID()}/${sanitize(input.filename)}`;
  await client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: key,
      Body: input.bytes,
      ContentType: input.contentType,
    }),
  );

  const url = `${process.env.R2_PUBLIC_BASE_URL}/${key}`;
  const [row] = await (await tenantDb(input.projectId))
    .insert(assets)
    .values({
      projectId: input.projectId,
      r2Key: key,
      filename: input.filename,
      contentType: input.contentType,
      size: String(input.bytes.length),
      url,
    })
    .returning();
  return row;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
}

/** True if the object exists (HeadObject). 404 → false; other errors rethrow. */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await client().send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key }));
    return true;
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (e as { name?: string }).name === "NotFound") return false;
    throw e;
  }
}

/** Fetch an object's bytes. */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const res = await client().send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

/** Store an object with content-type + a long immutable cache (derived images). */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

/** All keys under a prefix (continuation-token loop). */
export async function listPrefixKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await client().send(
      new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET!, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/**
 * Delete every R2 object a project owns (B2 project deletion). Keys are minted
 * as `${projectId}/uuid/filename`, so the project prefix cleanly scopes all its
 * originals + image derivatives. Returns the count removed. Best-effort — the
 * caller cascades the metadata rows regardless. (When R2 becomes a per-project
 * connector in A4, a managed bucket is dropped wholesale instead.)
 */
export async function deleteProjectObjects(projectId: string): Promise<number> {
  const keys = await listPrefixKeys(`${projectId}/`);
  for (let i = 0; i < keys.length; i += 1000) {
    await client().send(
      new DeleteObjectsCommand({
        Bucket: process.env.R2_BUCKET!,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
      }),
    );
  }
  return keys.length;
}

export async function listAssets(
  projectId: string,
  page?: { limit: number; offset: number },
): Promise<Asset[]> {
  let q = (await tenantDb(projectId))
    .select()
    .from(assets)
    .where(eq(assets.projectId, projectId))
    .orderBy(assets.createdAt, assets.id)
    .$dynamic();
  if (page) q = q.limit(page.limit).offset(page.offset);
  return q;
}

/**
 * Delete an asset (R2 object + metadata row). Blocked while any entry still
 * references its id — deleting would leave dangling refs the validator can't
 * repair. Asset ids are uuids, so a text containment check is precise.
 */
export async function deleteAsset(projectId: string, assetId: string): Promise<void> {
  const tdb = await tenantDb(projectId);
  const [asset] = await tdb
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.projectId, projectId)))
    .limit(1);
  if (!asset) throw new ValidationError(`asset ${assetId} not found`, "E_NOT_FOUND");

  const like = "%" + assetId + "%";
  const [ref] = await tdb
    .select({ n: sql<number>`count(*)` })
    .from(entries)
    .where(and(eq(entries.projectId, projectId), sql`${entries.data}::text LIKE ${like}`));
  if (Number(ref.n) > 0) {
    throw new ValidationError(
      `blocked: ${ref.n} entries still reference asset ${assetId} — clear those fields first`,
      "E_BLOCKED",
    );
  }

  // A trashed entry can still be restored, so it still pins the asset.
  const [trashRef] = await tdb
    .select({ n: sql<number>`count(*)` })
    .from(entriesTrash)
    .where(and(eq(entriesTrash.projectId, projectId), sql`${entriesTrash.data}::text LIKE ${like}`));
  if (Number(trashRef.n) > 0) {
    throw new ValidationError(
      `blocked: ${trashRef.n} trashed entries still reference asset ${assetId} — restore-and-clear the field or purge them first`,
      "E_BLOCKED",
    );
  }

  // Remove the original AND any cached image derivatives (under the asset's dir).
  // Prefix-delete ONLY when the key has the minted `projectId/uuid/filename`
  // shape — otherwise a malformed/legacy key could prefix-match unrelated
  // objects, so fall back to a single-object delete.
  const parts = asset.r2Key.split("/");
  const dir = asset.r2Key.slice(0, asset.r2Key.lastIndexOf("/"));
  const shapeOk = parts.length === 3 && parts[0] === projectId && parts[1].length > 0 && parts[2].length > 0;
  if (shapeOk) {
    const keys = new Set(await listPrefixKeys(`${dir}/`));
    keys.add(asset.r2Key); // ensure the original goes even if listing lagged
    const all = [...keys];
    for (let i = 0; i < all.length; i += 1000) {
      await client().send(
        new DeleteObjectsCommand({
          Bucket: process.env.R2_BUCKET!,
          Delete: { Objects: all.slice(i, i + 1000).map((Key) => ({ Key })) },
        }),
      );
    }
  } else {
    await client().send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: asset.r2Key }));
  }
  await tdb.delete(assets).where(eq(assets.id, assetId));
}
