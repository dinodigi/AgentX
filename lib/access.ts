import "server-only";
import { currentUser } from "@clerk/nextjs/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { projectMembers, projects, workspaceMembers, type Project } from "@/db/schema";

/**
 * Access control — a three-rung ladder (B1), strongest rung wins:
 *   1. Platform operators (emails in ADMIN_EMAILS) — see/operate every project.
 *   2. Workspace role — a member of the project's OWNING workspace operates it
 *      (owner/admin/manager all cascade to `operator` at the project level).
 *   3. project_members row — the per-project share for an outsider
 *      (`operator` = settings + content, `client` = content only). The
 *      client-handoff path.
 *
 * getProjectRole + accessibleProjects are the only two authorization choke
 * points; every surface (settings, connectors, upload/export, the dashboard)
 * goes through them, so the ladder is enforced app-wide from here.
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

  // Rung 2: a member of the project's owning workspace operates the project.
  const [project] = await db
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (project?.workspaceId) {
    const [ws] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, project.workspaceId),
          eq(workspaceMembers.clerkUserId, viewer.userId),
        ),
      )
      .limit(1);
    if (ws) return "operator";
  }

  // Rung 3: an explicit per-project share.
  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.clerkUserId, viewer.userId)))
    .limit(1);
  return member ? (member.role as Role) : null;
}

/**
 * B4 support access (decision #6, settled 2026-07-11): does the viewer reach
 * this project through a TENANT rung — workspace membership or a per-project
 * share — as opposed to only the platform-operator rung? An operator with no
 * tenant rung into the project is doing SUPPORT ACCESS: allowed, but recorded
 * in platform_events and visible to the tenant in Settings.
 */
export async function hasTenantRung(projectId: string, viewer: Viewer): Promise<boolean> {
  const [project] = await db
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (project?.workspaceId) {
    const [ws] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, project.workspaceId),
          eq(workspaceMembers.clerkUserId, viewer.userId),
        ),
      )
      .limit(1);
    if (ws) return true;
  }
  const [member] = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.clerkUserId, viewer.userId)))
    .limit(1);
  return Boolean(member);
}

/** Projects grouped by how the viewer reaches them — for the dashboard. */
export interface AccessibleProjects {
  /** Reached via workspace membership (the viewer's own workspaces). */
  owned: Project[];
  /** Reached only via a per-project share (an outsider handoff). */
  shared: Project[];
}

/**
 * Every project the viewer can open, grouped. Platform operators get all of
 * them under `owned`. Others get their workspace projects under `owned` and any
 * outsider-shared projects (a project_members row whose workspace they are NOT
 * in) under `shared`.
 */
export async function accessibleProjectsGrouped(): Promise<AccessibleProjects> {
  const viewer = await getViewer();
  if (!viewer) return { owned: [], shared: [] };
  // B4: the everyday dashboard is personal even for platform operators — they see
  // only their own workspace/shared projects here, exactly like any tenant. The
  // cross-tenant "god view" moved to the operator console (/admin/console).
  // Operators keep god-mode ACCESS via getProjectRole; this only scopes the
  // dashboard LISTING.

  const [wsRows, memberRows] = await Promise.all([
    db.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.clerkUserId, viewer.userId)),
    db.select({ projectId: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.clerkUserId, viewer.userId)),
  ]);
  const workspaceIds = wsRows.map((r) => r.id);
  const memberProjectIds = memberRows.map((r) => r.projectId);

  if (workspaceIds.length === 0 && memberProjectIds.length === 0) return { owned: [], shared: [] };

  const rows = await db
    .select()
    .from(projects)
    .where(
      or(
        workspaceIds.length ? inArray(projects.workspaceId, workspaceIds) : undefined,
        memberProjectIds.length ? inArray(projects.id, memberProjectIds) : undefined,
      ),
    );

  const wsSet = new Set(workspaceIds);
  const owned: Project[] = [];
  const shared: Project[] = [];
  for (const p of rows) {
    // A workspace project is "owned"; a share you also happen to have in your
    // own workspace still counts as owned (strongest rung).
    if (p.workspaceId && wsSet.has(p.workspaceId)) owned.push(p);
    else shared.push(p);
  }
  return { owned, shared };
}

/** Flat list of accessible projects (compat with existing callers). */
export async function accessibleProjects(): Promise<Project[]> {
  const { owned, shared } = await accessibleProjectsGrouped();
  return [...owned, ...shared];
}
