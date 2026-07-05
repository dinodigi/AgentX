import type { CSSProperties, ReactNode } from "react";
import { notFound } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { getProject } from "@/lib/admin";
import { getProjectRole } from "@/lib/access";
import { listCollections } from "@/lib/collections";
import { Sidebar } from "@/components/Sidebar";

/**
 * The branded workspace shell: ink rail + paper canvas. The per-project
 * --brand CSS variable set here is the single saturated color in the room —
 * every brand-* utility inside reskins to this project.
 */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ projectId: string }>;
  children: ReactNode;
}) {
  const { projectId } = await params;
  const [project, collections, role] = await Promise.all([
    getProject(projectId),
    listCollections(projectId),
    getProjectRole(projectId),
  ]);
  // No access reads as not-found: don't leak which project ids exist.
  if (!project || !role) notFound();

  const brand = safeColor(project.branding.primaryColor);
  const displayName = project.branding.displayName ?? project.name;

  return (
    <div
      className="flex min-h-screen"
      style={{ "--brand": brand } as CSSProperties}
    >
      <Sidebar
        projectId={projectId}
        projectName={displayName}
        logoUrl={project.branding.logoUrl}
        collections={collections.map((c) => ({
          name: c.name,
          displayName: c.displayName,
          publicWrite: c.publicWrite,
        }))}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[--color-line] px-8 py-3">
          <span className="eyebrow">{displayName}</span>
          <UserButton />
        </header>
        <main className="page-enter mx-auto w-full max-w-4xl flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}

/** Only allow simple color tokens to avoid style injection. */
function safeColor(v: string | undefined): string {
  if (v && /^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  return "#4f46e5";
}
