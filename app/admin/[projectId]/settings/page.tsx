import { notFound } from "next/navigation";
import { count, desc, eq, inArray, and } from "drizzle-orm";
import { db } from "@/db";
import { tenantDb } from "@/lib/data-plane";
import { assets, entries, projects, projectTokens, projectMembers, webhookDeliveries, jobs } from "@/db/schema";
import { getProjectRole, getViewer } from "@/lib/access";
import { canDeleteProject } from "@/lib/workspaces";
import { listCollections } from "@/lib/collections";
import { listSchedules } from "@/lib/schedules";
import { listProjectPlatformEvents } from "@/lib/platform-events";
import { TokensSection, WebhookForm, MembersSection, SecretReveal, ManageBillingButton, PluginsSection } from "./sections";
import { effectiveCatalog, enabledPlugins } from "@/lib/plugins";
import { DeleteProjectSection } from "./DeleteProjectSection";
import { refireDeliveryAction, cancelJobAction, toggleScheduleAction } from "./actions";

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

  const viewer = await getViewer();
  const canDelete = viewer ? await canDeleteProject(projectId, viewer) : false;

  // Tokens/members/jobs/project = control plane; deliveries + the delete-plan
  // counts below read the project's data plane.
  const tdb = await tenantDb(projectId);
  const [collections, tokens, members, deliveries, projectRow, automationJobs, schedules, platformTrail, enabledPluginIds] = await Promise.all([
    listCollections(projectId),
    db
      .select({
        id: projectTokens.id,
        label: projectTokens.label,
        scope: projectTokens.scope,
        createdAt: projectTokens.createdAt,
        lastUsedAt: projectTokens.lastUsedAt,
      })
      .from(projectTokens)
      .where(eq(projectTokens.projectId, projectId)),
    db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId)),
    tdb
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.projectId, projectId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(15),
    db
      .select({
        secret: projects.webhookSigningSecret,
        name: projects.name,
        branding: projects.branding,
        plan: projects.plan,
        billingStatus: projects.billingStatus,
        billingExempt: projects.billingExempt,
        stripeCustomerId: projects.stripeCustomerId,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .then((r) => r[0]),
    // Automation: work still in the queue or needing attention (succeeded rows
    // are noise here; the delivery log holds outcomes).
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ["pending", "running", "failed"])))
      .orderBy(desc(jobs.runAt))
      .limit(20),
    listSchedules(projectId),
    listProjectPlatformEvents(projectId, 12),
    enabledPlugins(projectId),
  ]);
  const pluginCatalog = await effectiveCatalog(projectId);

  const formCollections = collections.filter((c) => c.publicWrite);

  // Billing section shows for paid, non-exempt projects (sandbox/legacy/exempt
  // have no subscription to manage). "Manage" opens the Stripe portal once a
  // subscription exists (stripeCustomerId set by the checkout webhook).
  const paidPlan = projectRow?.plan === "byo" || projectRow?.plan === "managed";
  const showBilling = paidPlan && !projectRow?.billingExempt;

  const projectLabel = projectRow?.branding?.displayName ?? projectRow?.name ?? "project";
  const deleteCounts = canDelete
    ? {
        collections: collections.length,
        entries: (await tdb.select({ n: count() }).from(entries).where(eq(entries.projectId, projectId)))[0]?.n ?? 0,
        assets: (await tdb.select({ n: count() }).from(assets).where(eq(assets.projectId, projectId)))[0]?.n ?? 0,
      }
    : null;

  return (
    <>
      <p className="eyebrow mb-1">Project</p>
      <h1 className="display mb-6 text-xl font-semibold">Settings</h1>

      {showBilling && (
        <section className="mb-9">
          <h2 className="section-label mb-1">Billing</h2>
          <p className="mb-3 max-w-md text-sm text-ink-mute">
            {projectRow?.plan === "managed" ? "Managed" : "Bring-your-own-keys"} plan —{" "}
            {projectRow?.plan === "managed" ? "$29" : "$19"}/mo.
            {projectRow?.stripeCustomerId
              ? " Update your card, view invoices, or cancel in the Stripe portal."
              : " No active subscription yet — subscribe from the project's setup screen."}
          </p>
          <div className="card flex max-w-md flex-wrap items-center gap-3 p-4">
            <span
              className="chip"
              style={{
                color:
                  projectRow?.billingStatus === "active"
                    ? "var(--color-ok)"
                    : projectRow?.billingStatus === "canceled"
                      ? "var(--color-err)"
                      : projectRow?.billingStatus === "past_due"
                        ? "var(--color-warn)"
                        : undefined,
              }}
            >
              {projectRow?.billingStatus ?? "not subscribed"}
            </span>
            {projectRow?.stripeCustomerId && <ManageBillingButton projectId={projectId} />}
          </div>
        </section>
      )}

      <section className="mb-9">
        <h2 className="section-label mb-1">MCP tokens</h2>
        <p className="mb-3 max-w-md text-sm text-ink-mute">
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
            lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
          }))}
        />
      </section>

      <section className="mb-9">
        <h2 className="section-label mb-1">Webhook signing secret</h2>
        <p className="mb-3 max-w-md text-sm text-ink-mute">
          Outgoing webhooks carry <code className="font-mono text-xs">X-AgentX-Signature</code> —
          receivers verify with this secret (see the API reference).
        </p>
        <SecretReveal secret={projectRow?.secret ?? ""} />
      </section>

      <section className="mb-9">
        <h2 className="section-label mb-1">Webhooks</h2>
        <p className="mb-3 max-w-md text-sm text-ink-mute">
          Fired when a public form receives a submission. One per public-write
          collection.
        </p>
        {formCollections.length === 0 ? (
          <p className="card max-w-md p-4 text-sm text-ink-mute">
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
        <p className="mb-3 max-w-md text-sm text-ink-mute">
          Outcome of every webhook and email action — a lost lead is always
          visible here.
        </p>
        {deliveries.length === 0 ? (
          <p className="card max-w-md p-4 text-sm text-ink-mute">No deliveries yet.</p>
        ) : (
          <div className="card max-w-2xl overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">
                      <span className={`chip ${d.status === "success" ? "chip-ok" : "chip-bad"}`}>
                        {d.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{d.event}</td>
                    <td className="max-w-48 truncate px-3 py-2.5 font-mono text-xs text-ink-mute">
                      {d.url}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink-mute">
                      {d.createdAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                    </td>
                    <td className="max-w-40 truncate px-3 py-2.5 text-xs text-err">
                      {d.lastError}
                    </td>
                    <td className="px-3 py-2.5">
                      {d.status === "failed" && (
                        <form action={refireDeliveryAction.bind(null, projectId, d.id)}>
                          <button
                            type="submit"
                            className="btn !px-2.5 !py-1 text-xs"
                            title="Replay this delivery — the outcome lands as a new row"
                          >
                            Re-fire
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-9">
        <h2 className="section-label mb-1">Automation</h2>
        <p className="mb-3 max-w-md text-sm text-ink-mute">
          Background work: delayed event actions and recurring schedules. Job
          outcomes (webhooks/emails) land in the delivery log above.
        </p>
        {schedules.length === 0 && automationJobs.length === 0 ? (
          <p className="card max-w-md p-4 text-sm text-ink-mute">
            No schedules or queued jobs — agents create them via define_schedule
            and events with <code className="font-mono text-xs">after</code>.
          </p>
        ) : (
          <div className="space-y-3">
            {schedules.length > 0 && (
              <div className="card max-w-2xl overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {schedules.map((s) => (
                      <tr key={s.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-2.5 font-medium">{s.name}</td>
                        <td className="px-3 py-2.5 text-xs text-ink-mute">
                          {s.recurrence.frequency}
                          {s.recurrence.at ? ` at ${s.recurrence.at}` : ""}
                          {s.recurrence.weekday ? ` (${s.recurrence.weekday})` : ""}
                          {s.recurrence.dayOfMonth ? ` (day ${s.recurrence.dayOfMonth})` : ""}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-ink-mute">
                          {s.action.type === "webhook"
                            ? "webhook"
                            : s.action.type === "mutate"
                              ? `mutate:${s.action.collection}`
                              : `email:${s.action.to}`}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-ink-mute">
                          {s.enabled
                            ? `next ${s.nextRunAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                            : "paused"}
                        </td>
                        <td className="px-3 py-2.5">
                          <form action={toggleScheduleAction.bind(null, projectId, s.id, !s.enabled)}>
                            <button
                              type="submit"
                              className="btn !px-2.5 !py-1 text-xs"
                              title={
                                s.enabled
                                  ? "Pause — also skips already-queued fires"
                                  : "Resume — a missed window fires once, then advances"
                              }
                            >
                              {s.enabled ? "Pause" : "Resume"}
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {automationJobs.length > 0 && (
              <div className="card max-w-2xl overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {automationJobs.map((j) => (
                      <tr key={j.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-2.5">
                          <span className={`chip ${j.status === "failed" ? "chip-bad" : "chip-mute"}`}>
                            {j.status}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs">{j.kind}</td>
                        <td className="px-3 py-2.5 text-xs text-ink-mute">
                          {j.runAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-ink-mute">
                          {j.attempts}/{j.maxAttempts}
                        </td>
                        <td className="max-w-40 truncate px-3 py-2.5 text-xs text-err">{j.lastError}</td>
                        <td className="px-3 py-2.5">
                          {j.status === "pending" && (
                            <form action={cancelJobAction.bind(null, projectId, j.id)}>
                              <button
                                type="submit"
                                className="btn !px-2.5 !py-1 text-xs"
                                title="Cancel this queued job (only pending jobs cancel)"
                              >
                                Cancel
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="mb-9">
        <h2 className="section-label mb-1">Plugins</h2>
        <p className="mb-3 max-w-md text-sm text-ink-mute">
          Installable capabilities — structure, tools, and guidance your AI
          applies to the project. A structure-only plugin is what you&apos;d call
          a template; same mechanism.
        </p>
        <PluginsSection
          projectId={projectId}
          plugins={pluginCatalog.map((p) => ({
            id: p.id,
            name: p.name,
            version: p.version,
            description: p.description,
            enabled: enabledPluginIds.has(p.id),
          }))}
        />
      </section>

      <section className="mb-9">
        <h2 className="section-label mb-1">Manifest</h2>
        <p className="mb-3 max-w-md text-sm text-ink-mute">
          The whole project definition as one JSON doc — version it, diff it,
          replicate it via import_project.
        </p>
        <a href={`/api/admin/export?projectId=${projectId}`} className="btn" download>
          Download manifest
        </a>
      </section>

      <section className="mb-9">
        <h2 className="section-label mb-1">Members</h2>
        <p className="mb-3 max-w-md text-sm text-ink-mute">
          Who can open this admin. Operators manage settings; clients manage
          content.
        </p>
        <MembersSection
          projectId={projectId}
          members={members.map((m) => ({ id: m.id, email: m.email, role: m.role }))}
        />
      </section>

      <section>
        <h2 className="section-label mb-1">Platform access</h2>
        <p className="mb-3 max-w-md text-sm text-ink-mute">
          Platform operators can open this project for support. Every such
          visit — and any suspension — is recorded here, visible to you.
        </p>
        {platformTrail.length === 0 ? (
          <p className="card max-w-md p-4 text-sm text-ink-mute">
            No platform-operator access recorded.
          </p>
        ) : (
          <div className="card max-w-2xl overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {platformTrail.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">
                      <span className={`chip ${e.type === "suspend" ? "chip-bad" : "chip-mute"}`}>
                        {e.type === "support_access" ? "support access" : e.type}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-ink-mute">{e.actorEmail}</td>
                    <td className="max-w-56 truncate px-3 py-2.5 text-xs text-ink-mute">{e.note}</td>
                    <td className="px-3 py-2.5 text-xs text-ink-mute">
                      {e.createdAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canDelete && deleteCounts && (
        <section className="mt-10 border-t border-line pt-8">
          <h2 className="section-label mb-1 text-err">Danger zone</h2>
          <p className="mb-3 max-w-md text-sm text-ink-mute">
            Delete this project and everything in it. Only workspace owners and admins can.
          </p>
          <DeleteProjectSection projectId={projectId} label={projectLabel} counts={deleteCounts} />
        </section>
      )}
    </>
  );
}
