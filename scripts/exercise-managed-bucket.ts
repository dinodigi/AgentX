/**
 * A4c acceptance exercise: MANAGED bucket provisioning end to end — REAL S3
 * CreateBucket/DeleteBucket against our account (verified account-scoped
 * token), with only the Cloudflare REST managed-domain endpoint mocked
 * (CF_API_BASE) and the fake public domain served by intercepting fetch and
 * reading straight from the real bucket. Proves handle-first, resume, guards,
 * and teardown.
 *
 * Run on demand (no CF_API_TOKEN needed — the mock is local):
 *   node --env-file=.env node_modules/tsx/dist/cli.mjs --conditions react-server scripts/exercise-managed-bucket.ts
 */
import http from "node:http";
import { neon } from "@neondatabase/serverless";
import { S3Client, GetObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";

const FAKE_DOMAIN = "pub-exercise.example.test";

function direct(url: string): string {
  const u = new URL(url);
  u.hostname = u.hostname.replace(/-pooler(?=\.)/, "");
  return u.toString();
}

const admin = neon(direct(process.env.DATABASE_URL!));

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

async function bucketExists(bucket: string): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

/** Mock of ONLY the CF managed-domain endpoint. `failNext` simulates an outage. */
function startCfMock(state: { failNext: boolean; calls: number }) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      state.calls++;
      res.writeHead(state.failNext ? 500 : 200, { "content-type": "application/json" });
      const ok = !state.failNext;
      state.failNext = false;
      res.end(JSON.stringify(ok ? { success: true, result: { domain: FAKE_DOMAIN } } : { success: false }));
    });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** Serve the fake public domain from the real bucket via S3 (probe read-back). */
function interceptFetch(bucketRef: { name: string }) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`https://${FAKE_DOMAIN}/`)) {
      const key = decodeURIComponent(new URL(url).pathname.slice(1));
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucketRef.name, Key: key }));
        return new Response(Buffer.from(await res.Body!.transformToByteArray()), { status: 200 });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function main() {
  const cfState = { failNext: false, calls: 0 };
  const cf = await startCfMock(cfState);
  process.env.CF_API_BASE = cf.url;
  process.env.CF_API_TOKEN = "exercise-token";

  const { provisionManagedBucket, deprovisionManagedBucket, connectR2Bucket, disconnectR2Bucket } = await import(
    "../lib/r2-connector"
  );

  const [project] = await admin(
    `INSERT INTO projects (name, branding, webhook_signing_secret)
     VALUES ('managed bucket exercise', '{"displayName":"mb","primaryColor":"#0f766e"}'::jsonb, 'x')
     RETURNING id`,
  );
  const pid = (project as { id: string }).id;
  const bucket = `agentx-${pid}`;
  const restoreFetch = interceptFetch({ name: bucket });

  try {
    // 1) CF outage AFTER the bucket exists: handle stored, status error.
    cfState.failNext = true;
    let r = await provisionManagedBucket(pid);
    if (r.ok) throw new Error("(1) provision should fail during the CF outage");
    if (!(await bucketExists(bucket))) throw new Error("(1) bucket should exist (handle-first)");
    const [half] = await admin(
      `SELECT config->>'bucket' AS b, status FROM project_connectors WHERE project_id = '${pid}' AND type = 'r2'`,
    );
    const halfRow = half as { b: string; status: string };
    if (halfRow?.b !== bucket || halfRow.status !== "error") throw new Error("(1) handle row wrong");
    console.log("1) handle-first: bucket + row stored before the CF failure, status=error");

    // 2) Retry resumes: CreateBucket tolerates already-owned, domain enables,
    //    probe round-trips through the (intercepted) public domain.
    r = await provisionManagedBucket(pid);
    if (!r.ok) throw new Error(`(2) ${r.detail}`);
    const [full] = await admin(
      `SELECT config->>'publicBaseUrl' AS base, status FROM project_connectors WHERE project_id = '${pid}' AND type = 'r2'`,
    );
    const fullRow = full as { base: string; status: string };
    if (fullRow.status !== "connected" || fullRow.base !== `https://${FAKE_DOMAIN}`) {
      throw new Error(`(2) expected connected @ https://${FAKE_DOMAIN}, got ${fullRow.status} @ ${fullRow.base}`);
    }
    console.log("2) resume: provisioned, probe passed through the public domain, connected");

    // 3) Managed guards.
    r = await provisionManagedBucket(pid);
    if (r.ok || !/already provisioned/.test(r.detail)) throw new Error(`(3a) ${r.detail}`);
    r = await connectR2Bucket(pid, {
      accountId: process.env.R2_ACCOUNT_ID!,
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      bucket: process.env.R2_BUCKET!,
      publicBaseUrl: process.env.R2_PUBLIC_BASE_URL!,
    });
    if (r.ok || !/deprovision/.test(r.detail)) throw new Error(`(3b) ${r.detail}`);
    const d1 = await disconnectR2Bucket(pid);
    if (d1.ok || !/Deprovision/.test(d1.detail)) throw new Error(`(3c) ${d1.detail}`);
    console.log("3) managed guards hold (re-provision / BYO overwrite / disconnect refused)");

    // 4) Deprovision: bucket really deleted, row gone.
    const d2 = await deprovisionManagedBucket(pid);
    if (!d2.ok) throw new Error(`(4) ${d2.detail}`);
    if (await bucketExists(bucket)) throw new Error("(4) bucket still exists");
    const gone = await admin(`SELECT id FROM project_connectors WHERE project_id = '${pid}' AND type = 'r2'`);
    if (gone.length !== 0) throw new Error("(4) row still present");
    console.log("4) deprovision: bucket deleted for real, routing removed");

    console.log("ALL MANAGED-BUCKET CHECKS PASSED");
  } finally {
    restoreFetch();
    await admin(`DELETE FROM projects WHERE id = '${pid}'`);
    // Belt+braces: never leave the exercise bucket behind on a failed run.
    const { DeleteObjectsCommand, ListObjectsV2Command, DeleteBucketCommand } = await import("@aws-sdk/client-s3");
    try {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch {
      /* already gone — the success path */
    }
    await cf.close();
    s3.destroy();
  }
}

main().catch((e) => {
  console.error("EXERCISE FAILED:", e);
  process.exit(1);
});
