#!/usr/bin/env node
/**
 * verify-isolation — PROVE an experiment environment cannot touch production.
 *
 * Written 2026-08-07 for docs/plans/ENV-EXPERIMENT-SETUP.md. The setup checklist
 * is a list of intentions; this is the check that turns it into a fact. Every
 * query here is READ-ONLY (SELECT and count only) — this script can never be the
 * thing that damages either environment.
 *
 * The failure modes it exists to catch, worst first:
 *   1. the experiment sharing production's DATABASE_URL      → writes land in prod
 *   2. a drain cron wired at production's web service        → runs prod's queued
 *      jobs early, which means REAL emails and webhooks to REAL customers
 *   3. production's PLATFORM_STRIPE_* copied across          → real charges
 *   4. NEON_API_KEY / CF_API_TOKEN copied across             → real Neon projects
 *      and R2 buckets created on your account
 *   5. a shared CONNECTOR_MASTER_KEY                         → "relabeling, not
 *      isolating" (ENV-1); the experiment can decrypt prod's connector secrets
 *   6. APP_URL left as production                            → clients generated
 *      on the experiment point at pluggie.app
 *
 * Usage — from the repo root:
 *
 *   # compare a candidate experiment env against production's .env
 *   node scripts/verify-isolation.mjs --experiment .env.experiment
 *
 *   # also probe the DEPLOYED experiment service (recommended)
 *   node scripts/verify-isolation.mjs --experiment .env.experiment \
 *        --url https://agentx-experiment.onrender.com --token agx_...
 *
 * Exit 0 = isolated. Exit 1 = something is shared; the message says which.
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const expFile = argOf("--experiment");
const baseUrl = argOf("--url");
const token = argOf("--token");

if (!expFile) {
  console.error("usage: node scripts/verify-isolation.mjs --experiment <envfile> [--url <base> --token <mcp token>]");
  process.exit(2);
}

/** Minimal .env parser — KEY=value, ignores comments and blank lines. */
function parseEnv(path) {
  const out = {};
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(`cannot read ${path}`);
    process.exit(2);
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** host + database name only — never print a credential. */
function dbIdentity(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

const prod = parseEnv(".env");
const exp = parseEnv(expFile);

const problems = [];
const passes = [];
const notes = [];

// ── 1. The database ────────────────────────────────────────────────────────
if (!exp.DATABASE_URL) {
  problems.push("DATABASE_URL is not set in the experiment env — it would fall back to nothing, or worse, to a shell value");
} else if (!prod.DATABASE_URL) {
  notes.push("no DATABASE_URL in .env to compare against — cannot prove the DB differs");
} else if (exp.DATABASE_URL === prod.DATABASE_URL) {
  problems.push(
    `DATABASE_URL is IDENTICAL to production (${dbIdentity(prod.DATABASE_URL)}) — every define and write on the ` +
      "experiment would land in production's control plane. This is the one that matters most.",
  );
} else if (dbIdentity(exp.DATABASE_URL) === dbIdentity(prod.DATABASE_URL)) {
  problems.push(
    `DATABASE_URL points at the SAME host and database as production (${dbIdentity(prod.DATABASE_URL)}) — ` +
      "different credentials, same data. Still production.",
  );
} else {
  passes.push(`database differs: experiment=${dbIdentity(exp.DATABASE_URL)} vs prod=${dbIdentity(prod.DATABASE_URL)}`);
}

// ── 2. The master key ──────────────────────────────────────────────────────
if (!exp.CONNECTOR_MASTER_KEY) {
  notes.push("CONNECTOR_MASTER_KEY unset in the experiment env — connectors will refuse cleanly, which is safe");
} else if (exp.CONNECTOR_MASTER_KEY === prod.CONNECTOR_MASTER_KEY) {
  problems.push(
    "CONNECTOR_MASTER_KEY is SHARED with production — the experiment could decrypt production's connector " +
      'secrets. ENV-1\'s own words: "sharing one master key is relabeling, not isolating."',
  );
} else {
  passes.push("CONNECTOR_MASTER_KEY differs from production");
}

// ── 3. APP_URL ─────────────────────────────────────────────────────────────
// Production's APP_URL is NOT in local .env — it is set only in Render. Comparing
// against `prod.APP_URL` therefore compared against undefined and passed
// anything, including the exact production URL. Caught by pointing this script at
// a deliberately-production env and watching it approve pluggie.app. render.yaml
// declares the value statically, so that is the authoritative source in-repo.
function prodAppUrlFromBlueprint() {
  try {
    const yaml = readFileSync("render.yaml", "utf8");
    const m = /key:\s*APP_URL\s*\n\s*value:\s*(\S+)/.exec(yaml);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}
const prodAppUrl = prod.APP_URL || prodAppUrlFromBlueprint();
if (!exp.APP_URL) {
  problems.push(
    "APP_URL is unset — the origin falls back to forwarded headers, and every caller-facing URL " +
      "(MCP endpoint, deliveryBase, the generated client's baked DEFAULT_BASE_URL) becomes unreliable",
  );
} else if (!prodAppUrl) {
  notes.push("could not determine production's APP_URL from .env or render.yaml — cannot prove APP_URL differs");
} else if (exp.APP_URL.replace(/\/$/, "") === prodAppUrl.replace(/\/$/, "")) {
  problems.push(
    `APP_URL is PRODUCTION's (${prodAppUrl}) — a client generated on the experiment would point at ` +
      "production, and Stripe webhook registration would target it too",
  );
} else if (new URL(exp.APP_URL).host === new URL(prodAppUrl).host) {
  problems.push(`APP_URL uses production's host (${new URL(prodAppUrl).host}) — different path, same origin`);
} else {
  passes.push(`APP_URL is the experiment's own origin (${exp.APP_URL}), not ${prodAppUrl}`);
}

// ── 4. The vars that should be ABSENT, not copied ──────────────────────────
// Each degrades cleanly when unset — that is deliberate in render.yaml's own
// comments — and each is dangerous when present.
const MUST_BE_ABSENT = [
  ["PLATFORM_STRIPE_SECRET_KEY", "experimental code could create REAL charges"],
  ["PLATFORM_STRIPE_WEBHOOK_SECRET", "pairs with the secret key above"],
  ["NEON_API_KEY", "managed provisioning could create REAL Neon projects on your account"],
  ["CF_API_TOKEN", "could create REAL R2 buckets on your account"],
  ["MARKETING_INTAKE_TOKEN", "is a production delivery token"],
];
for (const [key, why] of MUST_BE_ABSENT) {
  if (exp[key]) problems.push(`${key} is SET on the experiment — ${why}. Omit it; the code refuses cleanly without it.`);
  else passes.push(`${key} correctly absent`);
}

// ── 5. R2 bucket ───────────────────────────────────────────────────────────
if (exp.R2_BUCKET && prod.R2_BUCKET && exp.R2_BUCKET === prod.R2_BUCKET) {
  problems.push(
    `R2_BUCKET is production's ("${exp.R2_BUCKET}") — experiment uploads would land among real assets, and ` +
      "either side's orphan sweep could delete the other's files",
  );
} else if (exp.R2_BUCKET) {
  passes.push(`R2_BUCKET differs ("${exp.R2_BUCKET}")`);
} else {
  notes.push("R2_BUCKET unset — uploads will fail, which is safe but you will want one eventually");
}

// ── 6. Live proof: the experiment database should be EMPTY ─────────────────
// Production holds real projects. A correctly isolated experiment DB starts at
// zero, so this is the least ambiguous evidence available. READ-ONLY.
if (exp.DATABASE_URL && !problems.some((p) => p.startsWith("DATABASE_URL"))) {
  try {
    const sql = neon(exp.DATABASE_URL);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM projects`;
    if (n === 0) {
      passes.push("experiment database holds 0 projects — empty, as a fresh environment should be");
    } else {
      notes.push(
        `experiment database holds ${n} project(s). Fine if you have already been using it; ` +
          "ALARMING if you expected it empty — check you did not point at production.",
      );
    }
    if (prod.DATABASE_URL) {
      const prodSql = neon(prod.DATABASE_URL);
      const [{ n: pn }] = await prodSql`SELECT count(*)::int AS n FROM projects`;
      notes.push(`for contrast, production holds ${pn} project(s)`);
    }
  } catch (e) {
    notes.push(
      `could not query the experiment database (${e instanceof Error ? e.message.slice(0, 80) : e}) — ` +
        "if this is 'relation projects does not exist', the migrations have not been applied yet",
    );
  }
}

// ── 7. Live proof: the DEPLOYED service reports its own URLs ───────────────
if (baseUrl && token) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_project_info", arguments: {} },
      }),
    });
    const body = await res.json();
    const text = body?.result?.content?.[0]?.text;
    const info = text ? JSON.parse(text) : null;
    if (!info?.urls) {
      problems.push(`the deployed service did not answer get_project_info (HTTP ${res.status}) — check the token scope`);
    } else {
      const host = new URL(baseUrl).host;
      if (info.urls.mcp.includes(host)) passes.push(`deployed service reports its OWN mcp url (${info.urls.mcp})`);
      else problems.push(`deployed service reports mcp url ${info.urls.mcp} — that is not ${host}. APP_URL is wrong.`);
      if (prod.APP_URL && JSON.stringify(info.urls).includes(new URL(prod.APP_URL).host)) {
        problems.push("the deployed service's urls reference PRODUCTION's host — APP_URL is pointing at prod");
      }
      if (info.stripe?.configured) {
        problems.push("the deployed service reports stripe.configured=true — a Stripe connector is live on the experiment");
      } else {
        passes.push("deployed service reports no Stripe configured");
      }
    }
  } catch (e) {
    notes.push(`could not probe ${baseUrl}: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }
} else {
  notes.push("no --url/--token given — skipped the deployed-service probe (run it once the service is up)");
}

// ── Report ─────────────────────────────────────────────────────────────────
const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;

console.log("");
for (const p of passes) console.log(`  ${g("✓")} ${p}`);
for (const n of notes) console.log(`  ${y("·")} ${n}`);
console.log("");
if (problems.length === 0) {
  console.log(g("✓ ISOLATED — nothing shared with production that could damage it."));
  console.log("  Two things this CANNOT check, because they live outside the env file:");
  console.log("    1. a drain cron wired `fromService: agentx` would run PRODUCTION's queued jobs");
  console.log("       — real emails and webhooks to real customers. Verify in the Render dashboard.");
  console.log("    2. Clerk dashboard settings are SHARED if you share the instance — changing the");
  console.log("       session-token template affects production too.");
  console.log("");
  process.exit(0);
}
console.log(r(`✗ NOT ISOLATED — ${problems.length} problem(s):`));
for (const p of problems) console.log(`  ${r("✗")} ${p}`);
console.log("");
process.exit(1);
