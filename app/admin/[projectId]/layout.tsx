import type { CSSProperties, ReactNode } from "react";
import { notFound } from "next/navigation";
import { and, count, eq, isNull, inArray } from "drizzle-orm";
import { tenantDb } from "@/lib/data-plane";
import { entries } from "@/db/schema";
import { getProject } from "@/lib/admin";
import { getProjectAccess, hasTenantRung } from "@/lib/access";
import { latestSuspendNote, recordSupportAccess } from "@/lib/platform-events";
import { listCollections } from "@/lib/collections";
import { brandInk } from "@/lib/brand";
import { getSidebarCollapsed } from "@/lib/theme";
import { WorkspaceSidebar } from "@/components/admin/WorkspaceSidebar";
import { ContentSidebar } from "@/components/admin/ContentSidebar";

/**
 * The project workspace shell — three columns: the left chrome rail (switcher +
 * fixed project sections + account), the editing area, and the right ContentSidebar
 * (collections + inboxes, the part that grows with the schema). --brand is the
 * single client color, contained; the theme is governed by the admin root above.
 */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ projectId: string }>;
  children: ReactNode;
}) {
  const { projectId } = await params;
  const [project, collections, access, collapsed] = await Promise.all([
    getProject(projectId),
    listCollections(projectId),
    getProjectAccess(projectId),
    getSidebarCollapsed(),
  ]);

  // DX-8: the gate used to be `if (!project || !role) notFound()`, which made an
  // identity outage, a missing rung and a wrong project id one blank 404. The
  // SUCCESS path below is unchanged; only the failure branches gained a reason.
  if (!access.ok && access.reason === "provider_unavailable") {
    // An outage reads as an outage. Never notFound(): a 404 here sent a real
    // debugging session into the Clerk dashboard looking for a permissions bug.
    return <AccessProblem
      title="Cannot reach the identity provider"
      body="Your session could not be verified because Clerk did not answer. This is an outage, not a permissions problem — nothing about your access has changed. Reload in a moment."
      detail={access.detail}
    />;
  }
  // Anonymous: middleware normally redirects to sign-in long before here, so
  // reaching this means the session is genuinely absent. Stay opaque.
  if (!access.ok && access.reason === "anonymous") notFound();
  // No rung, or no such project — deliberately ONE outcome (see ProjectAccess).
  // What we CAN say is the viewer's own state, which is what separates "my
  // identity is fine, the rung is missing" from "Clerk is broken".
  if (!access.ok || !project) {
    const email = access.ok ? "" : access.reason === "no_rung" ? access.viewer.email : "";
    return <AccessProblem
      title="No access to this project"
      body={
        email
          ? `You are signed in as ${email}. That account has no role on this project — or the project does not exist. If you expect access, ask a workspace member to invite you, or check the project URL.`
          : "This project is not available to your account."
      }
    />;
  }
  const { role, viewer } = access;

  // B4 support access: an operator with no tenant rung into this project is
  // here for support — banner them, and record the visit (deduped) where the
  // tenant can see it. Suspension shows its tenant-visible reason the same way.
  const supportAccess = viewer.isPlatformOperator && !(await hasTenantRung(projectId, viewer));
  if (supportAccess) await recordSupportAccess(projectId, viewer.email);
  const suspendNote = project.status === "suspended" ? await latestSuspendNote(projectId) : null;

  const inboxIds = collections.filter((c) => c.publicWrite).map((c) => c.id);
  const unhandled =
    inboxIds.length === 0
      ? []
      : await (await tenantDb(projectId))
          .select({ collectionId: entries.collectionId, n: count() })
          .from(entries)
          .where(and(inArray(entries.collectionId, inboxIds), isNull(entries.handledAt)))
          .groupBy(entries.collectionId);
  const unhandledById = new Map(unhandled.map((u) => [u.collectionId, u.n]));

  const brand = safeColor(project.branding.primaryColor);

  return (
    <div
      className="flex min-h-0 w-full flex-1"
      style={{ "--brand": brand, "--brand-ink": brandInk(brand) } as CSSProperties}
    >
      <WorkspaceSidebar currentId={projectId} isPlatformOperator={viewer.isPlatformOperator} />
      <main className="page-enter mx-auto min-w-0 max-w-[1400px] flex-1 px-5 py-7 md:px-10 md:py-9">
        {project.status === "suspended" && (
          <div
            className="mb-5 rounded-xl border px-4 py-3 text-[13px] leading-relaxed"
            style={{
              borderColor: "color-mix(in srgb, var(--color-err) 40%, transparent)",
              background: "color-mix(in srgb, var(--color-err) 8%, transparent)",
            }}
          >
            <p className="m-0 font-medium" style={{ color: "var(--color-err)" }}>
              This project is suspended by the platform operators — its agent and delivery APIs are dark.
            </p>
            <p className="m-0 mt-1 text-ink-mute">
              {suspendNote ? (
                <>
                  Reason: {suspendNote}.{" "}
                </>
              ) : null}
              Content and settings remain intact. Contact support to resolve it.
            </p>
          </div>
        )}
        {supportAccess && (
          <div className="mb-5 rounded-xl border border-line bg-card px-4 py-2.5 font-mono text-[11.5px] text-ink-mute">
            <span style={{ color: "var(--color-warn)" }}>support access</span> — you are a platform
            operator in a tenant&apos;s project. This visit is logged and visible to them in Settings.
          </div>
        )}
        {children}
      </main>
      <ContentSidebar
        currentId={projectId}
        content={collections.map((c) => ({
          name: c.name,
          displayName: c.displayName,
          publicWrite: c.publicWrite,
          unhandled: unhandledById.get(c.id) ?? 0,
        }))}
        defaultCollapsed={collapsed}
      />
    </div>
  );
}

/**
 * DX-8 — a refusal that names which question failed, in the project shell's own
 * chrome. Deliberately plain: no nav, no data reads (a failure page that queries
 * can fail again), and no claim about the project beyond what the viewer already
 * knows from the URL.
 */
function AccessProblem({ title, body, detail }: { title: string; body: string; detail?: string }) {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col justify-center gap-3 px-6 py-16">
      <h1 className="display m-0 text-lg font-semibold">{title}</h1>
      <p className="m-0 text-[13.5px] leading-relaxed text-ink-mute">{body}</p>
      {detail ? (
        <p className="m-0 rounded-lg border border-line bg-card px-3 py-2 font-mono text-[11.5px] text-ink-mute">
          {detail}
        </p>
      ) : null}
    </div>
  );
}

/** Only allow simple color tokens to avoid style injection. */
function safeColor(v: string | undefined): string {
  if (v && /^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  return "#4f46e5";
}
