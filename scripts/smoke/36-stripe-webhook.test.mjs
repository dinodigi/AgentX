import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { ensureServer, createEphemeralProject, connectStripe, BASE } from "./helpers.mjs";

// K3: inbound Stripe webhook — the whsec signature is the ONLY auth, and the
// project identity comes ONLY from the URL path. No Stripe network needed:
// we sign payloads ourselves with the seeded webhookSigning secret.
const WHSEC = "whsec_smoke_secret";

const sign = (body, { secret = WHSEC, t = Math.floor(Date.now() / 1000), extraV1 } = {}) => {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},${extraV1 ? `v1=${extraV1},` : ""}v1=${v1}`;
};

const post = (projectId, body, sig) =>
  fetch(`${BASE}/api/stripe/webhook/${projectId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sig ? { "stripe-signature": sig } : {}) },
    body,
  });

const EVENT = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });

describe("stripe webhook ingestion (K3)", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("stripe-webhook");
    await connectStripe(p.id, { whsec: WHSEC });
  });
  after(async () => {
    await p.destroy();
  });

  it("a correctly signed event is acknowledged 200 {received:true}", async () => {
    const res = await post(p.id, EVENT, sign(EVENT));
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const json = JSON.parse(text);
    assert.equal(json.received, true);
    assert.equal(json.type, "checkout.session.completed");
  });

  it("rotation: any matching v1 among several verifies", async () => {
    const res = await post(p.id, EVENT, sign(EVENT, { extraV1: "0".repeat(64) }));
    const text = await res.text();
    assert.equal(res.status, 200, text);
  });

  it("a tampered body fails with 400 (signature covers the exact bytes)", async () => {
    const sig = sign(EVENT);
    const tampered = EVENT.replace("evt_1", "evt_2");
    const res = await post(p.id, tampered, sig);
    assert.equal(res.status, 400);
  });

  it("a stale timestamp fails with 400 even when correctly signed (replay bound)", async () => {
    const res = await post(p.id, EVENT, sign(EVENT, { t: Math.floor(Date.now() / 1000) - 400 }));
    assert.equal(res.status, 400);
  });

  it("a wrong-length v1 fails with 400, not a crash (length-checked compare)", async () => {
    const t = Math.floor(Date.now() / 1000);
    const res = await post(p.id, EVENT, `t=${t},v1=deadbeef`);
    assert.equal(res.status, 400);
  });

  it("a missing signature header fails with 400", async () => {
    const res = await post(p.id, EVENT);
    assert.equal(res.status, 400);
  });

  it("an oversized body is rejected 413 — not buffered unboundedly (DoS guard)", async () => {
    const huge = JSON.stringify({ type: "checkout.session.completed", pad: "A".repeat(1_100_000) });
    const res = await post(p.id, huge, sign(huge));
    assert.equal(res.status, 413, await res.clone().text());
  });

  it("signing with the sk must NOT verify — the webhookSigning slot never falls back", async () => {
    // The connector's primary secret is sk_test_smoke; a signature minted with
    // it would pass only if connectorSecret fell back to secretEnc.
    const res = await post(p.id, EVENT, sign(EVENT, { secret: "sk_test_smoke" }));
    assert.equal(res.status, 400);
  });

  it("no webhookSigning slot configured → 503 (never verified against another secret)", async () => {
    const bare = await createEphemeralProject("stripe-webhook-noslot");
    try {
      await connectStripe(bare.id); // sk only, no whsec slot
      const res = await post(bare.id, EVENT, sign(EVENT));
      assert.equal(res.status, 503, await res.clone().text());
    } finally {
      await bare.destroy();
    }
  });

  it("an unknown project id is 503-unconfigured; a non-uuid path is 404 pre-DB", async () => {
    const ghost = await post(randomUUID(), EVENT, sign(EVENT));
    assert.equal(ghost.status, 503);
    const junk = await post("not-a-uuid", EVENT, sign(EVENT));
    assert.equal(junk.status, 404);
  });
});
