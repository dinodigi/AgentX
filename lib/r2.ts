import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { assets, type Asset } from "@/db/schema";

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

export async function uploadAsset(input: UploadInput): Promise<Asset> {
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
