import "server-only";
import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { revalidateTag } from "next/cache";
import { controlDb } from "@/db";
import { assets, projectConnectors, type ProjectConnector } from "@/db/schema";
import { tenantDb } from "./data-plane";
import { connectorsTag } from "./connectors";
import { encryptSecret, decryptSecret } from "./crypto";
import { evictStorageClient, r2Endpoint, listPrefixKeys, deleteKeys } from "./r2";

/**
 * The `r2` connector (A4): the project's own object storage. BYO = the tenant
 * brings a Cloudflare R2 bucket (account id + S3 keys + bucket + THEIR public
 * base URL); managed (A4c) = we create a bucket per project in our account.
 * Like `neon`, this module is the only storing path — the generic connector
 * form's type cannot express it — so a stored r2 connector always passed the
 * live write-and-publicly-read-back probe.
 *
 * BYO invariant: we NEVER create or delete objects the platform didn't mint,
 * and disconnect only removes routing (their bucket stays theirs).
 */

export interface R2ConnectInput {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** The tenant's public serving base (custom domain or enabled r2.dev URL). */
  publicBaseUrl: string;
}

export interface StorageConnectResult {
  ok: boolean;
  detail: string;
}

async function r2Row(projectId: string): Promise<ProjectConnector | null> {
  const [row] = await controlDb
    .select()
    .from(projectConnectors)
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "r2")))
    .limit(1);
  return row ?? null;
}

function revalidateConnectors(projectId: string): void {
  try {
    revalidateTag(connectorsTag(projectId));
  } catch {
    // Outside a Next request context (script/exercise) — nothing to refresh.
  }
}

/**
 * The full-loop probe: write a marker object with THEIR keys, fetch it back
 * through THEIR public base URL, then delete it. One pass proves credentials,
 * bucket existence, and public serving — the three ways a pasted config lies.
 */
export async function probeBucket(input: R2ConnectInput): Promise<StorageConnectResult> {
  const client = new S3Client({
    region: "auto",
    endpoint: r2Endpoint(input.accountId),
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
  });
  const probeKey = `_agentx-probe/${randomUUID()}.txt`;
  const marker = `agentx-probe-${randomUUID()}`;
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: input.bucket }));
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      return {
        ok: false,
        detail:
          status === 404
            ? `bucket "${input.bucket}" was not found on that account`
            : `could not reach the bucket (${e instanceof Error ? e.message : String(e)}) — check the account id and keys`,
      };
    }
    await client.send(
      new PutObjectCommand({ Bucket: input.bucket, Key: probeKey, Body: marker, ContentType: "text/plain" }),
    );
    try {
      const res = await fetch(`${input.publicBaseUrl.replace(/\/$/, "")}/${probeKey}`, {
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      const body = res.ok ? await res.text() : "";
      if (!res.ok || body !== marker) {
        return {
          ok: false,
          detail: `the bucket accepted a write, but the public base URL did not serve it back (HTTP ${res.status}) — enable public access on the bucket (custom domain or r2.dev) and use that URL`,
        };
      }
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: probeKey })).catch(() => {});
    }
    return { ok: true, detail: "bucket writable and publicly served" };
  } finally {
    client.destroy();
  }
}

/**
 * Attach a BYO bucket as this project's storage plane. Greenfield rule
 * mirrors A2: asset URLs are minted ABSOLUTE at upload from the storage
 * plane's public base, so the project must hold zero assets when the plane
 * changes (same-config re-connect is an allowed heal).
 */
export async function connectR2Bucket(projectId: string, input: R2ConnectInput): Promise<StorageConnectResult> {
  for (const [k, v] of Object.entries(input)) {
    if (!String(v ?? "").trim()) return { ok: false, detail: `${k} is required` };
  }
  if (!/^[0-9a-f]{32}$/i.test(input.accountId.trim())) {
    return { ok: false, detail: "accountId should be the 32-hex Cloudflare account id" };
  }
  try {
    const u = new URL(input.publicBaseUrl);
    if (u.protocol !== "https:") return { ok: false, detail: "publicBaseUrl must be https" };
  } catch {
    return { ok: false, detail: "publicBaseUrl must be a valid https URL" };
  }

  const existing = await r2Row(projectId);
  if (existing?.config?.mode === "managed") {
    return { ok: false, detail: "this project has a managed bucket — deprovision it before connecting your own" };
  }
  const sameConfig =
    existing?.config?.bucket === input.bucket &&
    existing?.config?.accountId === input.accountId.trim() &&
    existing?.config?.publicBaseUrl === input.publicBaseUrl.replace(/\/$/, "");

  if (!sameConfig) {
    // Zero-asset guard on the CURRENT content plane (asset metadata may be
    // tenant-side; its stored URLs point at the OLD storage plane).
    const tdb = await tenantDb(projectId);
    const [a] = await tdb.select({ n: count() }).from(assets).where(eq(assets.projectId, projectId));
    if ((a?.n ?? 0) > 0) {
      return {
        ok: false,
        detail: `this project already has ${a!.n} asset(s) whose URLs point at its current storage — asset migration isn't supported yet; connect a bucket before uploading`,
      };
    }
  }

  const probe = await probeBucket(input);
  if (!probe.ok) return probe;

  const oldCreds = existing?.secretEnc
    ? (JSON.parse(decryptSecret(existing.secretEnc)) as { accessKeyId: string })
    : null;
  const values = {
    projectId,
    type: "r2" as const,
    config: {
      mode: "byo",
      accountId: input.accountId.trim(),
      bucket: input.bucket.trim(),
      publicBaseUrl: input.publicBaseUrl.replace(/\/$/, ""),
    },
    secretEnc: encryptSecret(
      JSON.stringify({ accessKeyId: input.accessKeyId.trim(), secretAccessKey: input.secretAccessKey.trim() }),
    ),
    status: "connected",
    updatedAt: new Date(),
  };
  await controlDb
    .insert(projectConnectors)
    .values(values)
    .onConflictDoUpdate({
      target: [projectConnectors.projectId, projectConnectors.type],
      set: { config: values.config, secretEnc: values.secretEnc, status: "connected", updatedAt: values.updatedAt },
    });
  revalidateConnectors(projectId);
  if (existing?.config?.accountId && oldCreds) {
    evictStorageClient(r2Endpoint(existing.config.accountId), oldCreds.accessKeyId);
  }
  return {
    ok: true,
    detail: `connected — uploads and image derivatives for this project now live in "${input.bucket}" and serve from your URL`,
  };
}

// ---------------------------------------------------------------------------
// Managed buckets (A4c): our account, our env credentials, one bucket per
// project. Bucket create/delete ride the plain S3 API (verified: the platform
// token is account-scoped); only the r2.dev public URL needs the Cloudflare
// REST API (CF_API_TOKEN with R2:Edit). r2.dev is rate-limited/non-production
// per Cloudflare — accepted for launch; per-tenant custom domains later.
// ---------------------------------------------------------------------------

const CF_API_BASE = () => process.env.CF_API_BASE || "https://api.cloudflare.com/client/v4";

function platformClient(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint(process.env.R2_ACCOUNT_ID!),
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

/** Enable the bucket's r2.dev managed domain; returns the https public base. */
async function enableManagedDomain(bucket: string): Promise<string> {
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    throw new Error(
      "CF_API_TOKEN is not set — enabling the managed bucket's public URL needs a Cloudflare API token with R2:Edit (BYO buckets are unaffected)",
    );
  }
  const res = await fetch(
    `${CF_API_BASE()}/accounts/${process.env.R2_ACCOUNT_ID}/r2/buckets/${bucket}/domains/managed`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: { domain?: string } } | null;
  if (!res.ok || !body?.success || !body.result?.domain) {
    throw new Error(`Cloudflare managed-domain enable failed (HTTP ${res.status})`);
  }
  return `https://${body.result.domain}`;
}

/**
 * Provision a MANAGED bucket: one per project, in our account. Handle-first —
 * the bucket exists under a deterministic name (`agentx-<projectId>`) and the
 * row is stored BEFORE the public-domain step can fail, so a retry resumes
 * (CreateBucket tolerates already-owned; the domain PUT is idempotent).
 */
export async function provisionManagedBucket(projectId: string): Promise<StorageConnectResult> {
  const existing = await r2Row(projectId);
  if (existing?.config?.mode === "byo") {
    return { ok: false, detail: "this project uses a BYO bucket — disconnect it first if you want a managed one" };
  }
  if (existing?.config?.mode === "managed" && existing.config.publicBaseUrl && existing.status === "connected") {
    return { ok: false, detail: "a managed bucket is already provisioned for this project" };
  }

  // Zero-asset guard (asset URLs are minted absolute at upload). A managed row
  // mid-provisioning never served an upload (storageFor fails closed on it).
  if (!existing) {
    const tdb = await tenantDb(projectId);
    const [a] = await tdb.select({ n: count() }).from(assets).where(eq(assets.projectId, projectId));
    if ((a?.n ?? 0) > 0) {
      return {
        ok: false,
        detail: `this project already has ${a!.n} asset(s) on its current storage — asset migration isn't supported yet; provision before uploading`,
      };
    }
  }

  const bucket = `agentx-${projectId}`;
  const client = platformClient();
  try {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (e) {
      const name = (e as { name?: string }).name ?? "";
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/i.test(name)) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, detail: `could not create the bucket: ${msg}` };
      }
      // Already ours from a prior attempt — resume.
    }

    // HANDLE FIRST: the row names the bucket before the domain step can fail.
    const handle = {
      projectId,
      type: "r2" as const,
      config: { mode: "managed", accountId: process.env.R2_ACCOUNT_ID!, bucket, publicBaseUrl: "" },
      secretEnc: null as string | null, // managed uses the platform credentials
      status: "provisioning",
      updatedAt: new Date(),
    };
    await controlDb
      .insert(projectConnectors)
      .values(handle)
      .onConflictDoUpdate({
        target: [projectConnectors.projectId, projectConnectors.type],
        set: { config: handle.config, secretEnc: null, status: "provisioning", updatedAt: handle.updatedAt },
      });
    revalidateConnectors(projectId);

    let publicBaseUrl: string;
    try {
      publicBaseUrl = await enableManagedDomain(bucket);
      // Full-loop probe with the platform credentials — same bar as BYO.
      const probe = await probeBucket({
        accountId: process.env.R2_ACCOUNT_ID!,
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        bucket,
        publicBaseUrl,
      });
      if (!probe.ok) throw new Error(probe.detail);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await controlDb
        .update(projectConnectors)
        .set({ status: "error", updatedAt: new Date() })
        .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "r2")))
        .catch(() => {});
      revalidateConnectors(projectId);
      return { ok: false, detail: `bucket created but its public URL is not live (${msg}) — retry to resume` };
    }

    await controlDb
      .update(projectConnectors)
      .set({
        config: { mode: "managed", accountId: process.env.R2_ACCOUNT_ID!, bucket, publicBaseUrl },
        status: "connected",
        updatedAt: new Date(),
      })
      .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "r2")));
    revalidateConnectors(projectId);
    return { ok: true, detail: `managed bucket provisioned — uploads now serve from ${publicBaseUrl}` };
  } finally {
    client.destroy();
  }
}

/**
 * Tear down the MANAGED bucket: empty it, delete it, drop the routing row.
 * LOUD on failure — a bucket must never be silently orphaned. Destroys the
 * project's media; the caller gates this behind an explicit confirm.
 */
export async function deprovisionManagedBucket(projectId: string): Promise<StorageConnectResult> {
  const existing = await r2Row(projectId);
  if (!existing || existing.config?.mode !== "managed") {
    return { ok: false, detail: "this project has no managed bucket" };
  }
  const bucket = existing.config.bucket;
  const client = platformClient();
  try {
    if (bucket) {
      try {
        // Empty first — DeleteBucket requires it. storageFor may fail closed on
        // a half-provisioned row, so build the plane directly from the handle.
        const st = { client, bucket, publicBaseUrl: "", mode: "managed" as const };
        const keys = await listPrefixKeys(st, "");
        await deleteKeys(st, keys);
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      } catch (e) {
        const name = (e as { name?: string }).name ?? "";
        if (!/NoSuchBucket|NotFound/i.test(name)) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, detail: `could not delete the managed bucket (${msg}) — nothing was removed; retry` };
        }
      }
    }
    await controlDb
      .delete(projectConnectors)
      .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "r2")));
    revalidateConnectors(projectId);
    return { ok: true, detail: "managed bucket deleted — the project is back on the shared storage plane" };
  } finally {
    client.destroy();
  }
}

/**
 * Detach the BYO bucket: routing + cached clients only; the bucket and every
 * object stay the tenant's. Existing asset rows keep their (their-domain)
 * URLs — they remain servable as long as the tenant keeps the bucket public.
 */
export async function disconnectR2Bucket(projectId: string): Promise<StorageConnectResult> {
  const existing = await r2Row(projectId);
  if (existing?.config?.mode === "managed") {
    return { ok: false, detail: "this is a managed bucket — use Deprovision (it deletes the bucket) instead of Disconnect" };
  }
  const creds = existing?.secretEnc
    ? (JSON.parse(decryptSecret(existing.secretEnc)) as { accessKeyId: string })
    : null;
  await controlDb
    .delete(projectConnectors)
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "r2")));
  revalidateConnectors(projectId);
  if (existing?.config?.accountId && creds) {
    evictStorageClient(r2Endpoint(existing.config.accountId), creds.accessKeyId);
  }
  return {
    ok: true,
    detail: "disconnected — your bucket and its objects are untouched; new uploads use the shared plane",
  };
}
