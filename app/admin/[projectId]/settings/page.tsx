import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { projectTokens, projectMembers, webhookDeliveries } from "@/db/schema";
import { getProjectRole } from "@/lib/access";
import { listCollections } from "@/lib/collections";
import { TokensSection, WebhookForm, MembersSection } from "./sections";

/**
 * Settings tab: tokens, webhooks, members, manifest, delivery log.
 * Branding lives in Appearance; infrastructure lives in Connectors.
 */
export default async function SettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const role = await getProjectRole(projectId);
  if (role !== "operator") notFound();

  const [collections, tokens, members, deliveries] = await Promise.all([
    listCollections(projectId),
    db
      .select({
        id: projectTokens.id,
        label: projectTokens.label,
        scope: projectTokens.scope,
        createdAt: projectTokens.createdAt,
      })
      .from(projectTokens)
      .where(eq(projectTokens.projectId, projectId)),
    db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId)),
    db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.projectId, projectId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(15),
  ]);

  const formCollections = collections.filter((c) => c.publicWrite);

  return (
    <>
      <p className="eyebrow mb-1">Project</p>
      <h1 className="display mb-6 text-xl font-semibold">Settings</h1>

      <section className="mb-9">
        <h2 className="section-label mb-1">MCP tokens</h2>
        <p className="mb-3 max-w-md text-sm text-[--color-ink-mute]">
          Bearer tokens scoping the MCP server and delivery API to this project.
          Only hashes are stored — a token is visible once, when minted.
        </p>
        <TokensSection
          projectId={projectId}
          tokens={tokens.map((t) => ({
            id: t.id,
            label: t.label,
            scope: t.scope,
            createdAt: t.createdAt.toISOString(),
          }))}
        />
      </section>

      <section className="mb-9">
        <h2 className="section-label mb-1">Webhooks</h2>
        <p className="mb-3 max-w-md text-sm text-[--color-ink-mute]">
          Fired when a public form receives a submission. One per public-write
          collection.
        </p>
        {formCollections.length === 0 ? (
          <p className="card max-w-md p-4 text-sm text-[--color-ink-mute]">
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

      <section className="mb-9">
        <h2 className="section-label mb-1">Delivery log</h2>
        <p className="mb-3 max-w-md text-sm text-[--color-ink-mute]">
          Outcome of every webhook and email action — a lost lead is always
          visible here.
        </p>
        {deliveries.length === 0 ? (
          <p className="card max-w-md p-4 text-sm text-[--color-ink-mute]">No deliveries yet.</p>
        ) : (
          <div className="card max-w-2xl overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-[--color-line] last:border-0">
                    <td className="px-4 py-2.5">
                      <span className={`chip ${d.status === "success" ? "chip-ok" : "chip-bad"}`}>
                        {d.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{d.event}</td>
                    <td className="max-w-48 truncate px-3 py-2.5 font-mono text-xs text-[--color-ink-mute]">
                      {d.url}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[--color-ink-mute]">
                      {d.createdAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                    </td>
                    <td className="max-w-40 truncate px-3 py-2.5 text-xs text-red-600">
                      {d.lastError}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-9">
        <h2 className="section-label mb-1">Manifest</h2>
        <p className="mb-3 max-w-md text-sm text-[--color-ink-mute]">
          The whole project definition as one JSON doc — version it, diff it,
          replicate it via import_project.
        </p>
        <a href={`/api/admin/export?projectId=${projectId}`} className="btn" download>
          Download manifest
        </a>
      </section>

      <section>
        <h2 className="section-label mb-1">Members</h2>
        <p className="mb-3 max-w-md text-sm text-[--color-ink-mute]">
          Who can open this admin. Operators manage settings; clients manage
          content.
        </p>
        <MembersSection
          projectId={projectId}
          members={members.map((m) => ({ id: m.id, email: m.email, role: m.role }))}
        />
      </section>
    </>
  );
}
