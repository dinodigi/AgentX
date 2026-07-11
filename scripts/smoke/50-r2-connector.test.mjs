import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { BASE, ensureServer, createEphemeralProject, connectR2, mcp } from "./helpers.mjs";

/**
 * A4 acceptance (server path): a project with an `r2` connector mints asset
 * URLs from ITS storage plane's public base and keeps derivatives there too.
 * The seeded connector points at the REAL shared bucket/keys (so bytes are
 * physically written and deletable) but a DISTINCT public base URL — every
 * URL the server builds proves which plane it resolved.
 */

const TENANT_BASE = "https://tenant-cdn.example.test";

let project;

before(async () => {
  await ensureServer();
  project = await createEphemeralProject("r2-connector");
  await connectR2(project.id, {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    publicBaseUrl: TENANT_BASE,
  });
});

after(async () => {
  await project.destroy();
});

test("uploads mint URLs from the connector's public base; delete cleans the bytes", async () => {
  const up = await mcp(project.mcpToken, "upload_asset", {
    filename: "tenant-plane.txt",
    contentType: "text/plain",
    dataBase64: Buffer.from("hello tenant storage").toString("base64"),
  });
  assert.equal(up.ok, true, up.errorText);
  assert.equal(
    up.value.url.startsWith(`${TENANT_BASE}/${project.id}/`),
    true,
    `url should be minted from the connector base, got ${up.value.url}`,
  );

  const del = await mcp(project.mcpToken, "delete_asset", { id: up.value.id });
  assert.equal(del.ok, true, del.errorText);
});

test("image-transform derivatives live in and redirect to the tenant plane", async () => {
  const bytes = await sharp({
    create: { width: 128, height: 128, channels: 3, background: { r: 90, g: 30, b: 160 } },
  })
    .jpeg()
    .toBuffer();
  const up = await mcp(project.mcpToken, "upload_asset", {
    filename: "tenant.jpg",
    contentType: "image/jpeg",
    dataBase64: bytes.toString("base64"),
  });
  assert.equal(up.ok, true, up.errorText);

  try {
    const r = await fetch(`${BASE}/api/v1/assets/${up.value.id}/image?w=64`, { redirect: "manual" });
    assert.equal(r.status, 302, `expected 302, got ${r.status}`);
    const loc = r.headers.get("location") ?? "";
    assert.equal(
      loc.startsWith(`${TENANT_BASE}/${project.id}/`),
      true,
      `derivative redirect should use the connector base, got ${loc}`,
    );
    assert.match(loc, /\/_t\/w64\.webp$/);
  } finally {
    const del = await mcp(project.mcpToken, "delete_asset", { id: up.value.id });
    assert.equal(del.ok, true, del.errorText);
  }
});

test("a sibling fallback project still mints URLs from the shared base", async () => {
  const sibling = await createEphemeralProject("r2-sibling");
  try {
    const up = await mcp(sibling.mcpToken, "upload_asset", {
      filename: "shared.txt",
      contentType: "text/plain",
      dataBase64: Buffer.from("shared plane").toString("base64"),
    });
    assert.equal(up.ok, true, up.errorText);
    const sharedBase = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
    assert.equal(
      up.value.url.startsWith(`${sharedBase}/${sibling.id}/`),
      true,
      `sibling url should use the shared base, got ${up.value.url}`,
    );
    const del = await mcp(sibling.mcpToken, "delete_asset", { id: up.value.id });
    assert.equal(del.ok, true, del.errorText);
  } finally {
    await sibling.destroy();
  }
});
