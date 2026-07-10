import { notFound } from "next/navigation";
import { getProject } from "@/lib/admin";
import { getProjectRole } from "@/lib/access";
import { BrandingForm } from "../settings/sections";

/** Appearance tab — how the client's admin looks and feels. Operator-only. */
export default async function AppearancePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const role = await getProjectRole(projectId);
  if (role !== "operator") notFound();

  const project = await getProject(projectId);
  if (!project) notFound();

  return (
    <>
      <p className="eyebrow mb-1">Project</p>
      <h1 className="display mb-1 text-xl font-semibold">Appearance</h1>
      <p className="mb-6 max-w-md text-sm text-ink-mute">
        Name, color, and logo — what your client sees everywhere in this admin.
        The color becomes the accent across the whole workspace.
      </p>
      <BrandingForm
        projectId={projectId}
        initial={{
          displayName: project.branding.displayName ?? project.name,
          primaryColor: project.branding.primaryColor ?? "#4f46e5",
          logoUrl: project.branding.logoUrl ?? "",
        }}
      />
    </>
  );
}
