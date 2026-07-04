/**
 * Seed a project + MCP token for dogfooding. Run: npm run seed
 * Prints the raw token ONCE — copy it into your Claude Code MCP config.
 *
 * Usage: npm run seed -- "Currents Demo" "#0f766e"
 */
import "dotenv/config";
import { db } from "@/db";
import { projects, projectTokens } from "@/db/schema";
import { generateToken, hashToken } from "@/lib/tokens";

async function main() {
  const name = process.argv[2] ?? "Dogfood Project";
  const color = process.argv[3] ?? "#4f46e5";

  const [project] = await db
    .insert(projects)
    .values({
      name,
      branding: { displayName: name, primaryColor: color },
    })
    .returning();

  const raw = generateToken();
  await db.insert(projectTokens).values({
    projectId: project.id,
    tokenHash: hashToken(raw),
    scope: "mcp",
    label: "seed",
  });

  console.log("\n✅ Project created");
  console.log("   id:   ", project.id);
  console.log("   name: ", project.name);
  console.log("\n🔑 MCP token (shown once — save it now):");
  console.log("   " + raw);
  console.log("\n   Admin:   /admin/" + project.id);
  console.log("   MCP URL: http://localhost:3000/api/mcp\n");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
