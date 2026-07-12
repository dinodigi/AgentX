import Link from "next/link";
import { redirect } from "next/navigation";
import { and, count, eq } from "drizzle-orm";
import { UserButton } from "@clerk/nextjs";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getViewer } from "@/lib/access";
import { getActiveWorkspace } from "@/lib/workspaces";
import { NewProjectForm } from "./NewProjectForm";

/**
 * B2: creation is self-serve for every workspace owner/admin — the free
 * sandbox path. Paid planes (BYO/managed) render but stay invite-only until
 * B3 attaches billing to the same seam.
 */
export default async function NewProjectPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");

  const workspace = await getActiveWorkspace(viewer);
  const [sandboxes] = await db
    .select({ n: count() })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspace.id), eq(projects.plan, "sandbox")));

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-8 py-4">
          <Link href="/admin" className="display text-[15px] font-semibold tracking-tight">
            Agent<span className="text-ink-mute">X</span>
          </Link>
          <UserButton />
        </div>
      </header>

      <main className="page-enter mx-auto max-w-lg px-8 py-10">
        <p className="mb-3 text-sm text-ink-mute">
          <Link href="/admin" className="transition-colors hover:text-ink-soft">
            ← Projects
          </Link>
        </p>
        <p className="eyebrow mb-1.5">Studio</p>
        <h1 className="display mb-1 text-[26px] font-semibold leading-none">New project</h1>
        <p className="mb-6 text-sm text-ink-mute">
          A branded admin, MCP token, and delivery API — ready for an agent to
          define the data model. Creating in <span className="text-ink">{workspace.name}</span>.
        </p>
        <NewProjectForm sandboxUsed={(sandboxes?.n ?? 0) >= 1} />
      </main>
    </div>
  );
}
