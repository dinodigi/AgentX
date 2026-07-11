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
import { controlDb } from "@/db";
import { tenantDb } from "./data-plane";
import { assertAssetCap } from "./caps";
import { decryptSecret } from "./crypto";
import { assets, assetPointers, entries, entriesTrash, projectConnectors, type Asset } from "@/db/schema";
import { ValidationError } from "./validation";

/**
 * Object storage via the S3-compatible API. THE STORAGE PLANE RESOLVES PER
 * PROJECT (A4), mirroring lib/data-plane's tenantDb: a project with an `r2`
 * connector keeps its bytes in its OWN bucket (BYO or managed) and mints
 * public URLs from its own base; everyone else uses the shared bucket from
 * the platform env, keys namespaced per project. Bytes live in R2; metadata
 * lives in the `assets` table (tenant-plane since A1).
 */

export interface ProjectStorage {
  client: S3Client;
  bucket: string;
  /** No trailing slash. Public object URL = `${publicBaseUrl}/${key}`. */
  publicBaseUrl: string;
  mode: "shared" | "byo" | "managed";
}

// One client per distinct endpoint+key pair (the shared one included).
const clientCache = new Map<string, S3Client>();

function cachedClient(cacheKey: string, make: () => S3Client): S3Client {
  let c = clientCache.get(cacheKey);
  if (!c) {
    c = make();
    clientCache.set(cacheKey, c);
  }
  return c;
}

/** Drop a cached storage client — call on r2-connector change/disconnect. */
export function evictStorageClient(endpoint: string, accessKeyId: string): void {
  clientCache.delete(`${endpoint}|${accessKeyId}`);
}

export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function sharedStorage(): ProjectStorage {
  const endpoint = r2Endpoint(process.env.R2_ACCOUNT_ID!);
  const accessKeyId = process.env.R2_ACCESS_KEY_ID!;
  return {
    client: cachedClient(`${endpoint}|${accessKeyId}`, () =>
      new S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
      }),
    ),
    bucket: process.env.R2_BUCKET!,
    publicBaseUrl: (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
    mode: "shared",
  };
}

/**
 * The storage plane for a project. No `r2` connector → the shared bucket
 * (platform env). With one, FAIL-CLOSED on a malformed row — bytes must never
 * silently land in the shared bucket when the project owns storage.
 */
export async function storageFor(projectId: string): Promise<ProjectStorage> {
  const [row] = await controlDb
    .select({ config: projectConnectors.config, secretEnc: projectConnectors.secretEnc })
    .from(projectConnectors)
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "r2")))
    .limit(1);
  if (!row) return sharedStorage();

  const cfg = row.config as { mode?: string; accountId?: string; bucket?: string; publicBaseUrl?: string };

  // MANAGED: our account, our env credentials — only the bucket + public base
  // come from the row (no per-row copy of the platform secret). A row still
  // provisioning (no public base yet) fails closed rather than minting URLs
  // nobody can serve.
  if (cfg?.mode === "managed") {
    if (!cfg.bucket || !cfg.publicBaseUrl) {
      throw new Error(`managed r2 bucket for project ${projectId} is still provisioning or malformed (fail-closed)`);
    }
    const shared = sharedStorage();
    return { client: shared.client, bucket: cfg.bucket, publicBaseUrl: cfg.publicBaseUrl.replace(/\/$/, ""), mode: "managed" };
  }

  if (!cfg?.accountId || !cfg?.bucket || !cfg?.publicBaseUrl || !row.secretEnc) {
    throw new Error(`r2 connector for project ${projectId} is missing accountId/bucket/publicBaseUrl/credentials (fail-closed)`);
  }
  const creds = JSON.parse(decryptSecret(row.secretEnc)) as { accessKeyId: string; secretAccessKey: string };
  const endpoint = r2Endpoint(cfg.accountId);
  return {
    client: cachedClient(`${endpoint}|${creds.accessKeyId}`, () =>
      new S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
      }),
    ),
    bucket: cfg.bucket,
    publicBaseUrl: cfg.publicBaseUrl.replace(/\/$/, ""),
    mode: "byo",
  };
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
  await assertAssetCap(input.projectId, input.bytes.length); // B2 sandbox cap
  const st = await storageFor(input.projectId);
  const key = `${input.projectId}/${randomUUID()}/${sanitize(input.filename)}`;
  await st.client.send(
    new PutObjectCommand({
      Bucket: st.bucket,
      Key: key,
      Body: input.bytes,
      ContentType: input.contentType,
    }),
  );

  const url = `${st.publicBaseUrl}/${key}`;
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
  // Control-plane pointer: the public image-transform URL carries only the
  // asset id, so this is how the route finds the owning data plane (A2).
  await controlDb
    .insert(assetPointers)
    .values({ assetId: row.id, projectId: input.projectId })
    .onConflictDoNothing();
  return row;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
}

/** True if the object exists (HeadObject). 404 → false; other errors rethrow. */
export async function objectExists(st: ProjectStorage, key: string): Promise<boolean> {
  try {
    await st.client.send(new HeadObjectCommand({ Bucket: st.bucket, Key: key }));
    return true;
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (e as { name?: string }).name === "NotFound") return false;
    throw e;
  }
}

/** Fetch an object's bytes. */
export async function getObjectBytes(st: ProjectStorage, key: string): Promise<Buffer> {
  const res = await st.client.send(new GetObjectCommand({ Bucket: st.bucket, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

/** Store an object with content-type + a long immutable cache (derived images). */
export async function putObject(st: ProjectStorage, key: string, body: Buffer, contentType: string): Promise<void> {
  await st.client.send(
    new PutObjectCommand({
      Bucket: st.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

/** All keys under a prefix (continuation-token loop). */
export async function listPrefixKeys(st: ProjectStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await st.client.send(
      new ListObjectsV2Command({ Bucket: st.bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Batched delete of explicit keys (1000/request S3 limit). */
export async function deleteKeys(st: ProjectStorage, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await st.client.send(
      new DeleteObjectsCommand({
        Bucket: st.bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
      }),
    );
  }
}

/**
 * Project-delete byte cleanup (B2), MODE-AWARE (A4):
 * - shared: prefix-delete the project's objects from the platform bucket.
 * - byo: NEVER touch their bucket — we drop records/routing only.
 * - managed: objects go with the bucket at deprovision (A4c teardown), which
 *   project-delete runs before this; emptying here is a harmless no-op path.
 * Returns the count removed. Best-effort — the caller cascades metadata anyway.
 */
export async function deleteProjectObjects(projectId: string): Promise<number> {
  const st = await storageFor(projectId);
  if (st.mode === "byo") return 0;
  const keys = await listPrefixKeys(st, `${projectId}/`);
  await deleteKeys(st, keys);
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

  // Remove the original AND any cached image derivatives (under the asset's dir)
  // from the PROJECT'S storage plane. Prefix-delete ONLY when the key has the
  // minted `projectId/uuid/filename` shape — otherwise a malformed/legacy key
  // could prefix-match unrelated objects, so fall back to a single-object delete.
  const st = await storageFor(projectId);
  const parts = asset.r2Key.split("/");
  const dir = asset.r2Key.slice(0, asset.r2Key.lastIndexOf("/"));
  const shapeOk = parts.length === 3 && parts[0] === projectId && parts[1].length > 0 && parts[2].length > 0;
  if (shapeOk) {
    const keys = new Set(await listPrefixKeys(st, `${dir}/`));
    keys.add(asset.r2Key); // ensure the original goes even if listing lagged
    await deleteKeys(st, [...keys]);
  } else {
    await st.client.send(new DeleteObjectCommand({ Bucket: st.bucket, Key: asset.r2Key }));
  }
  await tdb.delete(assets).where(eq(assets.id, assetId));
  await controlDb.delete(assetPointers).where(eq(assetPointers.assetId, assetId));
}
