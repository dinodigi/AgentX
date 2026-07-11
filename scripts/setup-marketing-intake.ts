/**
 * LAUNCH-PLAN 0.2 — one-shot setup for the dogfooded marketing intake.
 *
 * Creates the "Pluggie Marketing" project + mcp/delivery tokens, defines the
 * publicWrite `signups` collection through the live MCP surface (the same path
 * an agent takes), proves a delivery POST lands, then writes
 * MARKETING_INTAKE_TOKEN into .env. Tokens are never printed.
 *
 * Run with the dev server up:  npx tsx scripts/setup-marketing-intake.ts
 * Base override:               SETUP_BASE=https://... npx tsx scripts/setup-marketing-intake.ts
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, projectTokens, entries } from "@/db/schema";
import { generateToken, hashToken } from "@/lib/tokens";

const BASE = process.env.SETUP_BASE ?? "http://localhost:3100";
const PROJECT_NAME = "Pluggie Marketing";
const ENV_KEY = "MARKETING_INTAKE_TOKEN";

async function mcp(token: string, tool: string, args: Record<string, unknown>) {
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
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = body.result?.content?.[0]?.text ?? "";
  if (body.result?.isError) throw new Error(`MCP ${tool} failed: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Write ENV_KEY into .env: replace an existing active assignment, else append. */
function persistToken(deliveryToken: string) {
  const envRaw = readFileSync(".env", "utf8");
  const line = `${ENV_KEY}=${deliveryToken}`;
  const anchored = new RegExp(`^\\s*${ENV_KEY}=.*$`, "m");
  if (anchored.test(envRaw)) {
    writeFileSync(".env", envRaw.replace(anchored, line));
    console.log(`Replaced ${ENV_KEY} in .env (restart the dev server to pick it up).`);
  } else {
    const sep = envRaw.endsWith("\n") || envRaw === "" ? "" : "\n";
    writeFileSync(
      ".env",
      `${envRaw}${sep}# LAUNCH-PLAN 0.2: delivery token for the marketing signups intake (server-side only)\n${line}\n`,
    );
    console.log(`Wrote ${ENV_KEY} to .env (restart the dev server to pick it up).`);
  }
}

async function main() {
  // Fail fast if the server is unreachable — BEFORE any DB writes, so a wrong
  // SETUP_BASE (e.g. the 3000-vs-3100 default mismatch) can't leave a
  // half-provisioned project behind.
  try {
    await fetch(`${BASE}/api/mcp`, { method: "GET" });
  } catch {
    console.error(`Cannot reach ${BASE} — is the dev server up? Override with SETUP_BASE=http://localhost:3100`);
    process.exit(1);
  }

  const existing = await db.select({ id: projects.id }).from(projects).where(eq(projects.name, PROJECT_NAME));
  if (existing.length > 0) {
    console.error(`"${PROJECT_NAME}" already exists (${existing[0].id}) — nothing to do.`);
    console.error(`If you need a fresh delivery token, mint one in the project's Settings and set ${ENV_KEY}.`);
    process.exit(1);
  }

  console.log(`Creating "${PROJECT_NAME}" …`);
  const [project] = await db
    .insert(projects)
    .values({
      name: PROJECT_NAME,
      branding: { displayName: "Pluggie", primaryColor: "#43DE83" },
      webhookSigningSecret: randomBytes(32).toString("hex"),
    })
    .returning();

  const mcpToken = generateToken();
  const deliveryToken = generateToken();

  // Everything after the project insert can fail against the live server; on any
  // failure, delete the just-created project so a rerun starts clean (FK cascade
  // removes the tokens/collection/entries).
  try {
    await db.insert(projectTokens).values([
      { projectId: project.id, tokenHash: hashToken(mcpToken), scope: "mcp", label: "marketing setup (agent)" },
      { projectId: project.id, tokenHash: hashToken(deliveryToken), scope: "delivery", label: "marketing site intake" },
    ]);

    console.log("Defining signups collection over MCP …");
    await mcp(mcpToken, "define_collection", {
      name: "signups",
      displayName: "Signups",
      publicWrite: true,
      fields: [
        {
          name: "email",
          label: "Email",
          type: "text",
          required: true,
          pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
          patternHint: "must be a valid email address",
          max: 320,
        },
        { name: "product", label: "Product", type: "enum", required: true, options: ["agentx", "hostile-agent"] },
        { name: "about", label: "What they want to build", type: "text", max: 2000 },
      ],
    });

    console.log("Proving a delivery POST lands …");
    const post = await fetch(`${BASE}/api/v1/signups`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deliveryToken}`,
        "content-type": "application/json",
        "x-forwarded-for": "10.99.0.1",
      },
      body: JSON.stringify({ email: "setup-probe@example.com", product: "agentx", about: "setup probe" }),
    });
    if (post.status !== 201) {
      throw new Error(`delivery POST expected 201, got ${post.status}: ${await post.text()}`);
    }
    const { id: probeId } = await post.json();
    await db.delete(entries).where(eq(entries.id, probeId));
    console.log("Delivery POST verified (probe entry removed).");

    persistToken(deliveryToken);
  } catch (err) {
    console.error("Setup failed after creating the project — rolling it back.");
    await db.delete(projects).where(eq(projects.id, project.id));
    throw err;
  }

  console.log("\n✅ Marketing intake ready");
  console.log("   project id: ", project.id);
  console.log("   admin:      /admin/" + project.id);
  console.log("   inbox:      /admin/" + project.id + "/signups");
  console.log("\n   NEXT: add " + ENV_KEY + " to the Render environment (same value as .env) and re-sync the Blueprint.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
