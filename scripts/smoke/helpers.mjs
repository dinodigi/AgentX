// Shared utilities for the smoke suite. Integration-level: runs against the
// live dev server on :3000 with an ephemeral project per test file, so real
// data is never touched and parallel files can't collide.
import { neon } from "@neondatabase/serverless";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createHash, randomBytes, randomUUID, createCipheriv } from "node:crypto";
import http from "node:http";

/** Override with SMOKE_BASE to run the suite against a deployment (prod smoke). */
export const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const sql = neon(process.env.DATABASE_URL);

export async function ensureServer() {
  try {
    const res = await fetch(`${BASE}/api/mcp`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok && res.status !== 401) throw new Error(`status ${res.status}`);
  } catch (e) {
    throw new Error(
      `AgentX dev server not reachable at ${BASE} — start it first (npm run dev). (${e.message})`,
    );
  }
}

function mintTokenRow() {
  const raw = "agx_" + randomBytes(24).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

/** Project + mcp/delivery tokens via direct SQL; destroy() cascades everything. */
export async function createEphemeralProject(label) {
  const name = `smoke ${label} ${Date.now()}`;
  const signingSecret = randomBytes(32).toString("hex");
  const [project] = await sql`
    INSERT INTO projects (name, branding, webhook_signing_secret)
    VALUES (${name}, ${JSON.stringify({ displayName: name, primaryColor: "#0f766e" })}::jsonb, ${signingSecret})
    RETURNING id`;
  const mcp = mintTokenRow();
  const delivery = mintTokenRow();
  await sql`INSERT INTO project_tokens (project_id, token_hash, scope, label) VALUES
    (${project.id}, ${mcp.hash}, 'mcp', 'smoke'),
    (${project.id}, ${delivery.hash}, 'delivery', 'smoke')`;
  return {
    id: project.id,
    mcpToken: mcp.raw,
    deliveryToken: delivery.raw,
    signingSecret,
    destroy: async () => {
      await sql`DELETE FROM projects WHERE id = ${project.id}`;
    },
  };
}

export async function queryAudit(projectId) {
  return sql`SELECT action, actor, changed_fields, entry_id FROM audit_log
    WHERE project_id = ${projectId} ORDER BY created_at`;
}

export async function tokenLastUsed(rawToken) {
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const [row] = await sql`SELECT last_used_at FROM project_tokens WHERE token_hash = ${hash}`;
  return row?.last_used_at ?? null;
}

/** Call an MCP tool; returns { ok, value?, errorText? }. */
export async function mcp(token, tool, args = {}) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  if (!res.ok) return { ok: false, errorText: `HTTP ${res.status}: ${await res.text()}` };
  const body = await res.json();
  const text = body.result?.content?.[0]?.text ?? "";
  if (body.result?.isError) return { ok: false, errorText: text };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: true, value: text };
  }
}

/** Delivery API request. Unique x-forwarded-for per call by default so the
 * rate limiter never couples unrelated tests. */
export async function delivery(token, path, { method = "GET", body, userToken, ip } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-forwarded-for": ip ?? `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
      ...(userToken ? { "x-user-token": userToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 204 etc. */
  }
  return { status: res.status, json };
}

/** In-process RS256 issuer with a real JWKS endpoint on an ephemeral port. */
export async function startMockIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "smoke-key", use: "sig", alg: "RS256" });

  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${server.address().port}`;

  return {
    issuer,
    tokenFor: (sub, opts = {}) => {
      let jwt = new SignJWT({ ...(opts.claims ?? {}) })
        .setProtectedHeader({ alg: "RS256", kid: "smoke-key" })
        .setIssuer(opts.issuer ?? issuer)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("15m");
      if (opts.aud) jwt = jwt.setAudience(opts.aud);
      return jwt.sign(privateKey);
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Attach the project's clerk connector to a mock issuer (direct SQL). */
export async function connectClerk(projectId, issuer, extraConfig = {}) {
  const config = { issuer, ...extraConfig };
  await sql`INSERT INTO project_connectors (project_id, type, config)
    VALUES (${projectId}, 'clerk', ${JSON.stringify(config)}::jsonb)
    ON CONFLICT (project_id, type) DO UPDATE SET config = EXCLUDED.config`;
}

/** Mirror of lib/crypto.ts encryptSecret (AES-256-GCM, iv.tag.ct base64url) so
 * the harness can seed a decryptable connector secret the server will read. */
function encryptSecret(plaintext) {
  const key = Buffer.from(process.env.CONNECTOR_MASTER_KEY, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64url")).join(".");
}

/** Attach a connected stripe connector with a decryptable secret key (direct SQL). */
export async function connectStripe(projectId, { sk = "sk_test_smoke", pk = "pk_test_smoke" } = {}) {
  await sql`INSERT INTO project_connectors (project_id, type, config, secret_enc, status)
    VALUES (${projectId}, 'stripe', ${JSON.stringify({ publishableKey: pk })}::jsonb, ${encryptSecret(sk)}, 'connected')
    ON CONFLICT (project_id, type) DO UPDATE SET
      config = EXCLUDED.config, secret_enc = EXCLUDED.secret_enc, status = 'connected'`;
}

/** Local webhook receiver capturing POST bodies + headers — deterministic, no httpbin.
 * setStatus(500) makes it fail deliveries until flipped back (re-fire tests). */
export async function startWebhookReceiver() {
  const received = [];
  let respondWith = 200;
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      // Parsed payload at top level (event tests), raw body+headers for signature tests.
      received.push({ ...JSON.parse(data || "{}"), raw: { headers: req.headers, body: data } });
      res.writeHead(respondWith);
      res.end(respondWith === 200 ? "ok" : "nope");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    received,
    setStatus: (n) => (respondWith = n),
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Poll until fn() is truthy or timeout. */
export async function waitFor(fn, { timeoutMs = 8000, stepMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

export async function queryDeliveries(projectId) {
  return sql`SELECT status, event, url FROM webhook_deliveries WHERE project_id = ${projectId}`;
}

export { randomUUID };
