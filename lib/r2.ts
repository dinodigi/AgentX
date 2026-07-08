import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
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
  const [row] = await db
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

export async function listAssets(
  projectId: string,
  page?: { limit: number; offset: number },
): Promise<Asset[]> {
  let q = db
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
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.projectId, projectId)))
    .limit(1);
  if (!asset) throw new ValidationError(`asset ${assetId} not found`, "E_NOT_FOUND");

  const like = "%" + assetId + "%";
  const [ref] = await db
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
  const [trashRef] = await db
    .select({ n: sql<number>`count(*)` })
    .from(entriesTrash)
    .where(and(eq(entriesTrash.projectId, projectId), sql`${entriesTrash.data}::text LIKE ${like}`));
  if (Number(trashRef.n) > 0) {
    throw new ValidationError(
      `blocked: ${trashRef.n} trashed entries still reference asset ${assetId} — restore-and-clear the field or purge them first`,
      "E_BLOCKED",
    );
  }

  await client().send(
    new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: asset.r2Key }),
  );
  await db.delete(assets).where(eq(assets.id, assetId));
}
