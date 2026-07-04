import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projectTokens, projectMembers } from "@/db/schema";
import { getProject } from "@/lib/admin";
import { getProjectRole } from "@/lib/access";
import { listCollections } from "@/lib/collections";
import { BrandingForm, TokensSection, WebhookForm, MembersSection } from "./sections";

/** Project settings: branding, tokens, webhooks, members. Operator-only. */
export default async function SettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const role = await getProjectRole(projectId);
  if (role !== "operator") notFound();

  const [project, collections, tokens, members] = await Promise.all([
    getProject(projectId),
    listCollections(projectId),
    db
      .select({
        id: projectTokens.id,
        label: projectTokens.label,
        createdAt: projectTokens.createdAt,
      })
      .from(projectTokens)
      .where(eq(projectTokens.projectId, projectId)),
    db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId)),
  ]);
  if (!project) notFound();

  const formCollections = collections.filter((c) => c.publicWrite);

  return (
    <>
      <h1 className="mb-6 text-lg font-medium">Settings</h1>

      <section className="mb-8">
        <h2 className="mb-1 font-medium">Branding</h2>
        <p className="mb-3 text-sm text-gray-500">
          What the client sees across this admin.
        </p>
        <BrandingForm
          projectId={projectId}
          initial={{
            displayName: project.branding.displayName ?? project.name,
            primaryColor: project.branding.primaryColor ?? "#4f46e5",
            logoUrl: project.branding.logoUrl ?? "",
          }}
        />
      </section>

      <section className="mb-8">
        <h2 className="mb-1 font-medium">MCP tokens</h2>
        <p className="mb-3 text-sm text-gray-500">
          Bearer tokens that scope the MCP server and delivery API to this project.
          Only hashes are stored — a token is visible once, when minted.
        </p>
        <TokensSection
          projectId={projectId}
          tokens={tokens.map((t) => ({
            id: t.id,
            label: t.label,
            createdAt: t.createdAt.toISOString(),
          }))}
        />
      </section>

      <section className="mb-8">
        <h2 className="mb-1 font-medium">Webhooks</h2>
        <p className="mb-3 text-sm text-gray-500">
          Fired when a public form receives a submission. One per public-write
          collection.
        </p>
        {formCollections.length === 0 ? (
          <p className="rounded-lg border border-gray-200 p-4 text-sm text-gray-400">
            No public-write collections yet.
          </p>
        ) : (
          <div className="space-y-3">
            {formCollections.map((c) => (
              <WebhookForm
                key={c.name}
                projectId={projectId}
                collectionName={c.name}
                displayName={c.displayName}
                initialUrl={c.webhookUrl ?? ""}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-1 font-medium">Manifest</h2>
        <p className="mb-3 text-sm text-gray-500">
          The whole project definition (branding + collections) as one JSON doc —
          version it, diff it, replicate it via import_project.
        </p>
        <a
          href={`/api/admin/export?projectId=${projectId}`}
          className="inline-block rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50"
          download
        >
          Download manifest
        </a>
      </section>

      <section>
        <h2 className="mb-1 font-medium">Members</h2>
        <p className="mb-3 text-sm text-gray-500">
          Who can open this admin. Operators manage settings; clients manage content.
        </p>
        <MembersSection
          projectId={projectId}
          members={members.map((m) => ({
            id: m.id,
            email: m.email,
            role: m.role,
          }))}
        />
      </section>
    </>
  );
}
