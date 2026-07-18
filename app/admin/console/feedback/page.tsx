import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { platformFeedback, projects } from "@/db/schema";
import { getViewer } from "@/lib/access";
import { WorkspaceSidebar } from "@/components/admin/WorkspaceSidebar";
import { FeedbackWall } from "./FeedbackWall";

/**
 * The feedback wall — every agent working any tenant project can send
 * platform feedback (send_feedback); this is the one place it all lands.
 * Operator-only. Reads the latest 200 with project names joined.
 */
export default async function FeedbackPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  if (!viewer.isPlatformOperator) redirect("/admin");

  const rows = await db
    .select({
      id: platformFeedback.id,
      projectId: platformFeedback.projectId,
      projectName: projects.name,
      category: platformFeedback.category,
      summary: platformFeedback.summary,
      detail: platformFeedback.detail,
      toolName: platformFeedback.toolName,
      status: platformFeedback.status,
      createdAt: platformFeedback.createdAt,
    })
    .from(platformFeedback)
    .leftJoin(projects, eq(platformFeedback.projectId, projects.id))
    .orderBy(desc(platformFeedback.createdAt))
    .limit(200);

  return (
    <>
      <WorkspaceSidebar canCreateProjects isPlatformOperator />
      <div className="page-enter min-w-0 flex-1 px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Feedback wall</h1>
            <p className="text-sm text-ink-mute">
              What agents across the fleet report hitting — limitations, bugs, friction, ideas.
            </p>
          </div>
          <Link href="/admin/console" className="btn btn-ghost text-sm">
            ← Console
          </Link>
        </div>
        <FeedbackWall
          items={rows.map((r) => ({
            id: r.id,
            project: r.projectName ?? (r.projectId ? `prj_${r.projectId.slice(0, 8)}` : "(deleted project)"),
            category: r.category,
            summary: r.summary,
            detail: r.detail,
            toolName: r.toolName,
            status: r.status,
            when: r.createdAt.toISOString(),
          }))}
        />
      </div>
    </>
  );
}
