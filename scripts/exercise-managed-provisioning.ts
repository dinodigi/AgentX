/**
 * A3 acceptance exercise: the MANAGED provisioning state machine, end to end,
 * against REAL databases on our Neon instance — only the Neon *control* API
 * is mocked (in-process; its create/delete actually CREATE/DROP DATABASE and
 * return real connection URIs). Proves handle-first ordering, mid-failure
 * quarantine + resume-by-replacement, the guards, and teardown.
 *
 * Run on demand (no NEON_API_KEY needed — the mock is local):
 *   node --env-file=.env node_modules/tsx/dist/cli.mjs --conditions react-server scripts/exercise-managed-provisioning.ts
 *
 * Not part of `npm run smoke` (it drives lib code directly, not the server;
 * the server-path routing equivalence is smoke 49's job).
 */
import http from "node:http";
import { neon } from "@neondatabase/serverless";

function direct(url: string): URL {
  const u = new URL(url);
  u.hostname = u.hostname.replace(/-pooler(?=\.)/, "");
  return u;
}

const admin = neon(direct(process.env.DATABASE_URL!).toString());

interface MockState {
  requests: { method: string; path: string }[];
  /** Neon-project id → actual database name on our instance. */
  dbs: Map<string, string>;
  /** When set, the next create returns a URI pointing at an unreachable host. */
  poisonNextCreate: boolean;
}

/** In-process Neon control API: create = real CREATE DATABASE, delete = DROP. */
async function startNeonMock(state: MockState): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      void (async () => {
        state.requests.push({ method: req.method ?? "?", path: req.url ?? "?" });
        const send = (code: number, obj: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        try {
          if (req.method === "POST" && req.url === "/projects") {
            const id = `mock-${Math.random().toString(36).slice(2, 10)}`;
            const dbName = `managed_${id.replace(/-/g, "_")}`;
            await admin(`CREATE DATABASE ${dbName}`);
            state.dbs.set(id, dbName);
            const uri = direct(process.env.DATABASE_URL!);
            uri.pathname = `/${dbName}`;
            const connectionUri = state.poisonNextCreate
              ? "postgres://u:p@unreachable.invalid.example/db"
              : uri.toString();
            state.poisonNextCreate = false;
            return send(201, {
              project: { id },
              connection_uris: [{ connection_uri: connectionUri }],
              operations: [{ id: "op1", action: "create_timeline", status: "running" }],
            });
          }
          const opsMatch = /^\/projects\/([^/]+)\/operations$/.exec(req.url ?? "");
          if (req.method === "GET" && opsMatch) {
            return send(200, { operations: [{ id: "op1", action: "create_timeline", status: "finished" }] });
          }
          const delMatch = /^\/projects\/([^/]+)$/.exec(req.url ?? "");
          if (req.method === "DELETE" && delMatch) {
            const dbName = state.dbs.get(delMatch[1]);
            if (!dbName) return send(404, { message: "project not found" });
            await admin(`DROP DATABASE ${dbName} WITH (FORCE)`);
            state.dbs.delete(delMatch[1]);
            return send(200, { message: "Deleted the specified project" });
          }
          return send(404, { message: "unhandled mock path" });
        } catch (e) {
          return send(500, { message: e instanceof Error ? e.message : String(e) });
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function main() {
  const state: MockState = { requests: [], dbs: new Map(), poisonNextCreate: false };
  const mock = await startNeonMock(state);
  process.env.NEON_API_BASE = mock.url;
  process.env.NEON_API_KEY = "exercise-key";

  // Import AFTER env is set (the client reads env per call anyway; belt+braces).
  const { provisionManagedDatabase, deprovisionManagedDatabase, connectNeonDatabase, disconnectNeonDatabase } =
    await import("../lib/neon-connector");
  const { tenantSchemaVersion } = await import("../lib/tenant-migrations");

  const [project] = await admin(
    `INSERT INTO projects (name, branding, webhook_signing_secret)
     VALUES ('managed exercise', '{"displayName":"managed exercise","primaryColor":"#0f766e"}'::jsonb, 'x')
     RETURNING id`,
  );
  const pid = (project as { id: string }).id;

  try {
    // 1) Zero-content guard.
    const [col] = await admin(
      `INSERT INTO collections (project_id, name, display_name, fields)
       VALUES ('${pid}', 'notes', 'Notes', '[{"name":"note","label":"Note","type":"text"}]'::jsonb) RETURNING id`,
    );
    await admin(
      `INSERT INTO entries (project_id, collection_id, data) VALUES ('${pid}', '${(col as { id: string }).id}', '{}'::jsonb)`,
    );
    let r = await provisionManagedDatabase(pid);
    if (r.ok || !/content row/.test(r.detail)) throw new Error(`(1) ${r.detail}`);
    await admin(`DELETE FROM entries WHERE project_id = '${pid}'`);
    console.log("1) zero-content guard holds for managed provisioning");

    // 2) Mid-failure: the create succeeds but the DB is unreachable → the
    //    HANDLE must already be stored, status error, no secret.
    state.poisonNextCreate = true;
    r = await provisionManagedDatabase(pid);
    if (r.ok) throw new Error("(2) poisoned provision should fail");
    const [half] = await admin(
      `SELECT config->>'neonProjectId' AS npid, status, secret_enc FROM project_connectors
       WHERE project_id = '${pid}' AND type = 'neon'`,
    );
    const halfRow = half as { npid: string | null; status: string; secret_enc: string | null };
    if (!halfRow?.npid) throw new Error("(2) teardown handle was NOT stored before the failure");
    if (halfRow.status !== "error" || halfRow.secret_enc !== null) {
      throw new Error(`(2) expected status=error + no secret, got ${halfRow.status}/${halfRow.secret_enc !== null}`);
    }
    const orphanId = halfRow.npid;
    console.log(`2) handle-first proven: ${orphanId} stored, status=error, no secret`);

    // 3) Retry: tears down the orphan (mock sees DELETE) and provisions fresh.
    r = await provisionManagedDatabase(pid);
    if (!r.ok) throw new Error(`(3) ${r.detail}`);
    if (!state.requests.some((q) => q.method === "DELETE" && q.path === `/projects/${orphanId}`)) {
      throw new Error("(3) orphan was not torn down on retry");
    }
    const [full] = await admin(
      `SELECT config->>'neonProjectId' AS npid, status, secret_enc FROM project_connectors
       WHERE project_id = '${pid}' AND type = 'neon'`,
    );
    const fullRow = full as { npid: string; status: string; secret_enc: string | null };
    if (fullRow.status !== "connected" || !fullRow.secret_enc) throw new Error("(3) not connected after retry");
    const liveDb = state.dbs.get(fullRow.npid);
    if (!liveDb) throw new Error("(3) no live database for the new project id");
    const uri = direct(process.env.DATABASE_URL!);
    uri.pathname = `/${liveDb}`;
    if ((await tenantSchemaVersion(uri.toString())) !== 1) throw new Error("(3) schema not installed");
    console.log(`3) resume-by-replacement: orphan deleted, fresh ${fullRow.npid} connected, schema v1`);

    // 4) Guards while managed: no re-provision, no BYO overwrite, no disconnect.
    r = await provisionManagedDatabase(pid);
    if (r.ok || !/already provisioned/.test(r.detail)) throw new Error(`(4a) ${r.detail}`);
    r = await connectNeonDatabase(pid, uri.toString());
    if (r.ok || !/deprovision/.test(r.detail)) throw new Error(`(4b) ${r.detail}`);
    const d1 = await disconnectNeonDatabase(pid);
    if (d1.ok || !/Deprovision/.test(d1.detail)) throw new Error(`(4c) ${d1.detail}`);
    console.log("4) managed guards hold (re-provision / BYO overwrite / disconnect all refused)");

    // 5) Deprovision: mock DELETE fires, database dropped, row gone.
    const d2 = await deprovisionManagedDatabase(pid);
    if (!d2.ok) throw new Error(`(5) ${d2.detail}`);
    if (state.dbs.size !== 0) throw new Error("(5) mock still tracks a live database");
    const gone = await admin(`SELECT id FROM project_connectors WHERE project_id = '${pid}' AND type = 'neon'`);
    if (gone.length !== 0) throw new Error("(5) connector row still present");
    console.log("5) deprovision: database deleted, routing removed");

    console.log("ALL MANAGED-PROVISIONING CHECKS PASSED");
  } finally {
    await admin(`DELETE FROM projects WHERE id = '${pid}'`);
    // Drop any database the mock still tracks (failed assertions above).
    for (const dbName of state.dbs.values()) {
      await admin(`DROP DATABASE ${dbName} WITH (FORCE)`).catch(() => {});
    }
    await mock.close();
  }
}

main().catch((e) => {
  console.error("EXERCISE FAILED:", e);
  process.exit(1);
});
