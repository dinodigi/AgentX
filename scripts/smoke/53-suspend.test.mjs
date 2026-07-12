import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { ensureServer, createEphemeralProject, mcp, delivery, BASE } from "./helpers.mjs";

/**
 * B4 suspend lever + platform-events trail. Suspension must darken EVERY
 * outbound surface — MCP, delivery, and the job queue — while the admin stays
 * reachable, and the operator-action trail must survive project deletion.
 * Status flips happen via direct SQL (the console action adds cache
 * revalidation on top), so each check uses a FRESH token — the same idiom as
 * 51-lifecycle: a cache miss reads the new status.
 */
const sql = neon(process.env.DATABASE_URL);
const SECRET = process.env.CRON_SECRET;

function mintToken() {
  const raw = "agx_" + randomBytes(24).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

async function freshMcpToken(projectId) {
  const t = mintToken();
  await sql`INSERT INTO project_tokens (project_id, token_hash, scope, label)
    VALUES (${projectId}, ${t.hash}, 'mcp', 'smoke-fresh')`;
  return t.raw;
}

async function freshDeliveryToken(projectId) {
  const t = mintToken();
  await sql`INSERT INTO project_tokens (project_id, token_hash, scope, label)
    VALUES (${projectId}, ${t.hash}, 'delivery', 'smoke-fresh')`;
  return t.raw;
}

async function drain() {
  const res = await fetch(`${BASE}/api/jobs/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
  return res.status;
}

describe("suspend: the operator abuse lever (B4)", () => {
  let p;
  before(async () => {
    await ensureServer();
    if (!SECRET || SECRET.length < 16) {
      throw new Error("CRON_SECRET (>=16 chars) must be set in .env for the drain tests");
    }
    p = await createEphemeralProject("suspend");
  });
  after(async () => {
    await p.destroy();
  });

  it("suspension darkens MCP (its own error) and delivery", async () => {
    await sql`UPDATE projects SET status = 'suspended' WHERE id = ${p.id}`;
    const r = await mcp(await freshMcpToken(p.id), "list_collections", {});
    assert.equal(r.ok, false);
    assert.match(r.errorText, /E_PROJECT_SUSPENDED|suspended by the platform operators/);

    const d = await delivery(await freshDeliveryToken(p.id), "/anything");
    assert.equal(d.status, 401, "a suspended project has no public surface");
  });

  it("unsuspension restores service", async () => {
    await sql`UPDATE projects SET status = 'active' WHERE id = ${p.id}`;
    const r = await mcp(await freshMcpToken(p.id), "list_collections", {});
    assert.equal(r.ok, true, r.errorText);
  });

  it("a suspended project's due jobs are not claimable; they resume on unsuspend", async () => {
    await sql`UPDATE projects SET status = 'suspended' WHERE id = ${p.id}`;
    const [job] = await sql`
      INSERT INTO jobs (project_id, kind, run_at)
      VALUES (${p.id}, 'noop', now() - interval '1 minute')
      RETURNING id`;

    assert.equal(await drain(), 200);
    let [row] = await sql`SELECT status FROM jobs WHERE id = ${job.id}`;
    assert.equal(row.status, "pending", "suspension must silence the job queue too");

    await sql`UPDATE projects SET status = 'active' WHERE id = ${p.id}`;
    // The queue may hold unrelated due work; a couple of drains bound the wait.
    for (let i = 0; i < 3 && row.status === "pending"; i++) {
      assert.equal(await drain(), 200);
      [row] = await sql`SELECT status FROM jobs WHERE id = ${job.id}`;
    }
    assert.equal(row.status, "succeeded", "the paused job resumes exactly once after unsuspension");
  });

  it("the platform-events trail survives project deletion (FK SET NULL + name snapshot)", async () => {
    const doomed = await createEphemeralProject("suspend-trail");
    const [event] = await sql`
      INSERT INTO platform_events (project_id, project_name, type, actor_email, note)
      VALUES (${doomed.id}, 'trail-proof', 'suspend', 'smoke@test', 'because')
      RETURNING id`;
    await doomed.destroy();
    const [row] = await sql`SELECT project_id, project_name, note FROM platform_events WHERE id = ${event.id}`;
    assert.ok(row, "the trail row must survive the project delete");
    assert.equal(row.project_id, null);
    assert.equal(row.project_name, "trail-proof");
    assert.equal(row.note, "because");
    await sql`DELETE FROM platform_events WHERE id = ${event.id}`;
  });
});
