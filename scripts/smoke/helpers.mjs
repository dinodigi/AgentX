// Shared utilities for the smoke suite. Integration-level: runs against the
// live dev server on :3000 with an ephemeral project per test file, so real
// data is never touched and parallel files can't collide.
import { neon } from "@neondatabase/serverless";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createHash, randomBytes, randomUUID, createCipheriv } from "node:crypto";
import http from "node:http";

/** Override with SMOKE_BASE to run the suite against a deployment (prod smoke). */
export const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
export const sql = neon(process.env.DATABASE_URL);

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
/**
 * Sweep ephemeral projects stranded by EARLIER runs.
 *
 * `destroy()` only runs if a suite reaches its `after()` hook — a crash, a throw
 * before `after`, or a Ctrl-C strands the project permanently. 185 had piled up
 * by 2026-07-22. Self-healing on create is the same shape the platform already
 * uses for trash retention and audit pruning: cheap, opportunistic, no separate
 * job to remember.
 *
 * Two guards, because this deletes rows in the CONTROL DB:
 *  - the name must match the EXACT minted shape below. `plan IS NULL` alone is
 *    NOT a safe filter — most real client projects are planless too.
 *  - only rows older than SWEEP_AFTER_HOURS, so a concurrently running suite
 *    can never sweep its own live fixtures.
 * Bounded per call so this is always a small, predictable delete.
 */
const SWEEP_AFTER_HOURS = 2;
const SWEEP_BATCH = 25;

async function sweepStrandedProjects() {
  try {
    const gone = await sql`
      DELETE FROM projects WHERE id IN (
        SELECT id FROM projects
        WHERE plan IS NULL
          AND name ~ '^smoke [a-z0-9-]+ [0-9]{13}$'
          AND created_at < now() - make_interval(hours => ${SWEEP_AFTER_HOURS})
        LIMIT ${SWEEP_BATCH}
      ) RETURNING id`;
    if (gone.length) console.error(`[smoke] swept ${gone.length} stranded ephemeral project(s)`);
  } catch (e) {
    // Never fail a test run over housekeeping.
    console.error("[smoke] sweep skipped:", e instanceof Error ? e.message : e);
  }
}

export async function createEphemeralProject(label) {
  await sweepStrandedProjects();
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

/** Attach a connected stripe connector with decryptable secrets (direct SQL).
 * whsec seeds the webhookSigning slot in secrets_enc (inbound webhook auth);
 * webhookEndpointId marks the connector as one-click-provisioned (K5). */
export async function connectStripe(projectId, { sk = "sk_test_smoke", pk = "pk_test_smoke", whsec, webhookEndpointId } = {}) {
  const slots = whsec ? { webhookSigning: encryptSecret(whsec) } : null;
  const config = { publishableKey: pk, ...(webhookEndpointId ? { webhookEndpointId } : {}) };
  await sql`INSERT INTO project_connectors (project_id, type, config, secret_enc, secrets_enc, status)
    VALUES (${projectId}, 'stripe', ${JSON.stringify(config)}::jsonb, ${encryptSecret(sk)},
            ${slots ? JSON.stringify(slots) : null}::jsonb, 'connected')
    ON CONFLICT (project_id, type) DO UPDATE SET
      config = EXCLUDED.config, secret_enc = EXCLUDED.secret_enc,
      secrets_enc = EXCLUDED.secrets_enc, status = 'connected'`;
}

/** Attach a BYO neon data-plane connector with a decryptable connection string
 * (direct SQL, mirroring what lib/neon-connector stores). The server's
 * migrate-before-first-use gate installs the schema on the first content op —
 * deliberately NOT pre-installed here so the gate itself is under test. */
export async function connectNeon(projectId, connString) {
  const host = new URL(connString).hostname;
  const config = { mode: "byo", host };
  await sql`INSERT INTO project_connectors (project_id, type, config, secret_enc, status)
    VALUES (${projectId}, 'neon', ${JSON.stringify(config)}::jsonb, ${encryptSecret(connString)}, 'connected')
    ON CONFLICT (project_id, type) DO UPDATE SET
      config = EXCLUDED.config, secret_enc = EXCLUDED.secret_enc, status = 'connected'`;
}

/** Attach a BYO r2 storage connector with decryptable credentials (direct SQL,
 * mirroring what lib/r2-connector stores). Tests typically point it at the
 * REAL shared bucket/keys but a DISTINCT publicBaseUrl, so URL minting proves
 * the resolver picked the connector while bytes stay physically testable. */
export async function connectR2(projectId, { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl }) {
  const config = { mode: "byo", accountId, bucket, publicBaseUrl: publicBaseUrl.replace(/\/$/, "") };
  const secret = encryptSecret(JSON.stringify({ accessKeyId, secretAccessKey }));
  await sql`INSERT INTO project_connectors (project_id, type, config, secret_enc, status)
    VALUES (${projectId}, 'r2', ${JSON.stringify(config)}::jsonb, ${secret}, 'connected')
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

/** Local before-write hook endpoint (I1a). Captures each request's headers +
 * parsed body for signature/envelope assertions; the response is switchable:
 * approve (default) → {ok:true}, reject → {ok:false,error}, malformed → non-JSON,
 * hang → never responds (fires the client's AbortSignal.timeout). */
export async function startHookReceiver() {
  const received = [];
  let mode = "approve";
  let rejectError = "nope";
  let transformData = {};
  let rejectSubstr = null;
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      let json = null;
      try {
        json = JSON.parse(data || "{}");
      } catch {
        /* raw only */
      }
      received.push({ headers: req.headers, body: data, json });
      if (mode === "hang") return; // no response → client times out
      if (mode === "malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("not json {{{");
      }
      res.writeHead(200, { "content-type": "application/json" });
      // rejectMatching = content-based: reject only items whose candidate JSON
      // contains the substring (for mixed-batch tests); approve the rest.
      const matched = mode === "rejectMatching" && JSON.stringify(json?.candidate?.data ?? {}).includes(rejectSubstr);
      // echo = a no-op transform: reply {ok:true, data} with the candidate UNCHANGED.
      const body =
        mode === "reject" || matched
          ? { ok: false, error: matched ? `rejected: ${rejectSubstr}` : rejectError }
          : mode === "transform"
            ? { ok: true, data: transformData }
            : mode === "echo"
              ? { ok: true, data: json?.candidate?.data ?? {} }
              : { ok: true };
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    received,
    approve: () => (mode = "approve"),
    reject: (err = "nope") => {
      mode = "reject";
      rejectError = err;
    },
    // transform: reply {ok:true, data} — the FULL new entry the hook wants written.
    transform: (data) => {
      mode = "transform";
      transformData = data;
    },
    echo: () => (mode = "echo"), // no-op transform: echo the candidate back
    rejectMatching: (substr) => {
      mode = "rejectMatching";
      rejectSubstr = substr;
    },
    malformed: () => (mode = "malformed"),
    hang: () => (mode = "hang"),
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Retry a transient stale-socket reset (ECONNRESET / fetch failed) — needed
 * for the FIRST call after a blocking child process (tsc via execFileSync)
 * outlives the dev server's HTTP keep-alive; see the ROADMAP test-harness note. */
export async function retryTransient(fn, tries = 3) {
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

/** Attach a connected resend connector with a decryptable API key (direct SQL). */
export async function connectResend(projectId, { key = "re_smoke_key", fromEmail = "hello@smoke.test" } = {}) {
  return connectEmailProvider(projectId, "resend", { key, fromEmail });
}

/** Connect ANY email-category provider (provider registry). connectResend is
 *  kept as the thin default so the 12 existing email suites stay untouched. */
export async function connectEmailProvider(
  projectId,
  type = "resend",
  { key = "smoke_key", fromEmail = "hello@smoke.test" } = {},
) {
  await sql`INSERT INTO project_connectors (project_id, type, config, secret_enc, status)
    VALUES (${projectId}, ${type}, ${JSON.stringify({ fromEmail })}::jsonb, ${encryptSecret(key)}, 'connected')
    ON CONFLICT (project_id, type) DO UPDATE SET
      config = EXCLUDED.config, secret_enc = EXCLUDED.secret_enc, status = 'connected'`;
}

/** Delivery-log rows including the JSON payload (queryDeliveries omits it). */
export async function deliveryLog(projectId) {
  return sql`SELECT status, event, url, payload FROM webhook_deliveries
    WHERE project_id = ${projectId} ORDER BY created_at DESC`;
}

/** Index names on the tenant `entries` table (scale-index tests). */
export async function entryIndexNames() {
  const rows = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'entries'`;
  return rows.map((r) => r.indexname);
}

/** A collection's id — lets a test compute its exact per-collection index name
 * (the entries table is shared, so suffix matching is unreliable). */
export async function collectionId(projectId, name) {
  const [row] = await sql`SELECT id FROM collections WHERE project_id = ${projectId} AND name = ${name}`;
  return row?.id ?? null;
}

export { randomUUID };

/**
 * Drive a rate-limited endpoint until it 429s. Deterministic against the
 * limiter's FIXED one-minute windows: attempts are counted per wall-clock
 * minute bucket (mirroring rate_windows), so a run that straddles a boundary
 * just keeps going in the new bucket instead of flaking — only a single
 * bucket exceeding the limit without a 429 is a real failure.
 */
export async function expectRateLimit429(fire, { max = 20, cap = 60 } = {}) {
  const perBucket = new Map();
  for (let i = 0; i < cap; i++) {
    const bucket = Math.floor(Date.now() / 60_000); // send-time ≈ server arrival
    const status = await fire(i);
    if (status === 429) return;
    const n = (perBucket.get(bucket) ?? 0) + 1;
    perBucket.set(bucket, n);
    if (n > max) throw new Error(`no 429 after ${n} requests inside one minute bucket`);
  }
  throw new Error(`no 429 within ${cap} attempts`);
}
