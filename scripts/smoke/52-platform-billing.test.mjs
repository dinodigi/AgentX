import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { BASE, ensureServer, mcp } from "./helpers.mjs";

/**
 * B3 platform billing over the wire: the /api/platform-stripe webhook is the
 * only writer of billingStatus — signed events flip it, bad signatures bounce,
 * and a cancellation darkens the project's surfaces immediately (the handler
 * revalidates the token cache).
 */

const sql = neon(process.env.DATABASE_URL);
const WHSEC = process.env.PLATFORM_STRIPE_WEBHOOK_SECRET;

function sign(body) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WHSEC).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function postEvent(event, sigOverride) {
  const body = JSON.stringify(event);
  return fetch(`${BASE}/api/platform-stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": sigOverride ?? sign(body) },
    body,
  });
}

function mintToken() {
  const raw = "agx_" + randomBytes(24).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

async function makePaidProject(label) {
  const [project] = await sql`
    INSERT INTO projects (name, branding, webhook_signing_secret, status, plan)
    VALUES (${`smoke ${label} ${Date.now()}`}, '{"displayName":"billing","primaryColor":"#0f766e"}'::jsonb,
            ${randomBytes(32).toString("hex")}, 'active', 'byo')
    RETURNING id`;
  const tok = mintToken();
  await sql`INSERT INTO project_tokens (project_id, token_hash, scope, label)
    VALUES (${project.id}, ${tok.hash}, 'mcp', 'smoke')`;
  return {
    id: project.id,
    mcpToken: tok.raw,
    destroy: async () => {
      await sql`DELETE FROM projects WHERE id = ${project.id}`;
    },
  };
}

test("checkout.session.completed activates billing; garbage signatures bounce", async () => {
  await ensureServer();
  assert.ok(WHSEC, "PLATFORM_STRIPE_WEBHOOK_SECRET must be in .env for this suite");
  const p = await makePaidProject("wh-activate");
  try {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_test_1",
          subscription: "sub_test_activate1",
          metadata: { kind: "platform_subscription", projectId: p.id },
        },
      },
    };

    const bad = await postEvent(event, "t=1,v1=deadbeef");
    assert.equal(bad.status, 400, "unsigned/garbage events must bounce");

    const ok = await postEvent(event);
    assert.equal(ok.status, 200);
    const [row] = await sql`
      SELECT billing_status, stripe_customer_id, stripe_subscription_id
      FROM projects WHERE id = ${p.id}`;
    assert.equal(row.billing_status, "active");
    assert.equal(row.stripe_customer_id, "cus_test_1");
    assert.equal(row.stripe_subscription_id, "sub_test_activate1");
  } finally {
    await p.destroy();
  }
});

test("subscription.deleted darkens the SAME token immediately (cache revalidated)", async () => {
  const p = await makePaidProject("wh-cancel");
  try {
    // Wire up billing via the webhook, then prove the surface is live.
    const subId = "sub_test_cancel1";
    await postEvent({
      type: "checkout.session.completed",
      data: {
        object: { customer: "cus_test_2", subscription: subId, metadata: { kind: "platform_subscription", projectId: p.id } },
      },
    });
    const before = await mcp(p.mcpToken, "list_collections", {});
    assert.equal(before.ok, true, before.errorText);

    const res = await postEvent({
      type: "customer.subscription.deleted",
      data: { object: { id: subId, status: "canceled" } },
    });
    assert.equal(res.status, 200);

    const after = await mcp(p.mcpToken, "list_collections", {});
    assert.equal(after.ok, false, "a canceled project's agent surface must go dark");
    assert.match(after.errorText, /E_BILLING_CANCELED|subscription has ended/);
  } finally {
    await p.destroy();
  }
});

test("billing-exempt projects ignore cancellation darkness", async () => {
  const p = await makePaidProject("wh-exempt");
  try {
    await sql`UPDATE projects SET billing_exempt = true, billing_status = 'canceled' WHERE id = ${p.id}`;
    const fresh = mintToken();
    await sql`INSERT INTO project_tokens (project_id, token_hash, scope, label)
      VALUES (${p.id}, ${fresh.hash}, 'mcp', 'smoke-exempt')`;
    const r = await mcp(fresh.raw, "list_collections", {});
    assert.equal(r.ok, true, r.errorText);
  } finally {
    await p.destroy();
  }
});
