import "server-only";
import { currentUser } from "@clerk/nextjs/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { projectMembers, projects, type Project } from "@/db/schema";

/**
 * Per-project access control. Two tiers:
 *  - Platform operators (emails in ADMIN_EMAILS) see every project.
 *  - Everyone else sees only projects where they hold a project_members row:
 *    `operator` = settings + content, `client` = content only.
 *
 * This is deliberately the shape of future multi-tenancy: a platform user's
 * dashboard is just "projects where they're a member".
 */

export type Role = "operator" | "client";

export interface Viewer {
  userId: string;
  email: string;
  isPlatformOperator: boolean;
}

export async function getViewer(): Promise<Viewer | null> {
  const user = await currentUser();
  if (!user) return null;
  const email = user.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "";
  return { userId: user.id, email, isPlatformOperator: isPlatformOperator(email) };
}

function isPlatformOperator(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email);
}

/** The viewer's effective role on a project, or null if no access. */
export async function getProjectRole(projectId: string): Promise<Role | null> {
  const viewer = await getViewer();
  if (!viewer) return null;
  if (viewer.isPlatformOperator) return "operator";
  const rows = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.clerkUserId, viewer.userId),
      ),
    )
    .limit(1);
  return rows[0] ? (rows[0].role as Role) : null;
}

/** Projects the viewer can open. Platform operators get all of them. */
export async function accessibleProjects(): Promise<Project[]> {
  const viewer = await getViewer();
  if (!viewer) return [];
  if (viewer.isPlatformOperator) return db.select().from(projects);

  const memberships = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.clerkUserId, viewer.userId));
  if (memberships.length === 0) return [];
  return db
    .select()
    .from(projects)
    .where(inArray(projects.id, memberships.map((m) => m.projectId)));
}
