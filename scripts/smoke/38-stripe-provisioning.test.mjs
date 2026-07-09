import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureServer, createEphemeralProject, connectStripe, mcp } from "./helpers.mjs";

// K5/K6 MCP surface (the provision ACTION itself is Clerk-gated admin UI; its
// Stripe HTTP layer is verified separately). Here: get_project_info reports the
// stripe status, and get_client_code emits a checkout() helper that compiles.
async function retryTransient(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const code = e?.cause?.code ?? e?.code;
      if (code !== "ECONNRESET" && !/fetch failed/.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw last;
}

const productFields = [
  { name: "title", label: "T", type: "text", required: true, publicRead: true },
  { name: "price_id", label: "P", type: "text", publicRead: true },
];
const checkout = { priceField: "price_id", successUrl: "https://shop.example.com/ok", cancelUrl: "https://shop.example.com/no" };

describe("stripe provisioning + client (K5/K6)", () => {
  let p, tmp;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("stripe-provisioning");
    tmp = mkdtempSync(path.join(tmpdir(), "agentx-k6-"));
    await connectStripe(p.id, { pk: "pk_test_k6demo" }); // sk + pk, NOT provisioned
    const def = await mcp(p.mcpToken, "define_collection", { name: "products", fields: productFields, checkout });
    assert.ok(def.ok, def.errorText);
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
    return p.destroy();
  });

  it("get_project_info reports stripe {configured, publishableKey, webhookProvisioned}", async () => {
    const info = await mcp(p.mcpToken, "get_project_info", {});
    assert.equal(info.value.stripe.configured, true);
    assert.equal(info.value.stripe.publishableKey, "pk_test_k6demo", "K6: pk exposed for the storefront");
    assert.equal(info.value.stripe.webhookProvisioned, false, "not provisioned yet");
    assert.match(info.value.urls.stripeWebhook, /\/api\/stripe\/webhook\//);
  });

  it("webhookProvisioned flips true once a webhook endpoint is stored (K5)", async () => {
    // Mirror what provisionStripeWebhook persists: an endpoint id in config.
    await connectStripe(p.id, { pk: "pk_test_k6demo", whsec: "whsec_x", webhookEndpointId: "we_test_seeded" });
    const info = await mcp(p.mcpToken, "get_project_info", {});
    assert.equal(info.value.stripe.webhookProvisioned, true);
  });

  it("get_client_code emits a typed checkout() that compiles under --strict (K6)", async () => {
    const r = await retryTransient(() => mcp(p.mcpToken, "get_client_code", {}));
    assert.ok(r.ok, r.errorText);
    assert.match(r.value.code, /async checkout\(/, "checkout helper present");
    assert.match(r.value.code, /collections: products/, "names the sellable collection");

    writeFileSync(path.join(tmp, "agentx.ts"), r.value.code);
    writeFileSync(
      path.join(tmp, "consumer.ts"),
      `import { createClient } from "./agentx";
const ax = createClient({ token: "t" });
export async function main(): Promise<void> {
  const session: { url: string; sessionId: string } = await ax.checkout(
    "products",
    [{ id: "abc", quantity: 2 }],
    { successUrl: "https://shop.example.com/ok" },
  );
  if (!session.url || !session.sessionId) throw new Error("unreachable");
}
`,
    );
    const tscBin = path.resolve("node_modules", "typescript", "bin", "tsc");
    execFileSync(
      process.execPath,
      [tscBin, "--strict", "--target", "es2022", "--module", "commonjs", "--lib", "es2022,dom", "--outDir", "out", "agentx.ts", "consumer.ts"],
      { cwd: tmp, stdio: "pipe" },
    );
  });

  it("no checkout() is generated for a project with no sellable collection", async () => {
    const plain = await createEphemeralProject("no-checkout");
    try {
      await mcp(plain.mcpToken, "define_collection", {
        name: "notes",
        fields: [{ name: "body", label: "B", type: "text", required: true, publicRead: true }],
      });
      const r = await retryTransient(() => mcp(plain.mcpToken, "get_client_code", {}));
      assert.ok(r.ok, r.errorText);
      assert.ok(!/async checkout\(/.test(r.value.code), "checkout helper must be absent when nothing is sellable");
    } finally {
      await plain.destroy();
    }
  });
});
