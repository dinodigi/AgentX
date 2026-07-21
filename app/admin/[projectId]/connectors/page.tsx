import { notFound } from "next/navigation";
import { CreditCard, Database, HardDrive, KeyRound, Mail } from "lucide-react";
import { getProjectRole } from "@/lib/access";
import { getProject } from "@/lib/admin";
import {
  listConnectors,
  CONNECTOR_SPECS,
  providersFor,
  type FormConnectorType,
} from "@/lib/connectors";

/** Every provider serving the email category — the registry is the source. */
const EMAIL_TYPES = providersFor("email") as FormConnectorType[];
import { ConnectorCard, NeonConnectorCard, R2ConnectorCard } from "../settings/sections";

/** Connectors tab — the project's bring-your-own infrastructure. Operator-only.
 * Grouped by category with an anchor/health row up top; the connector model is
 * unchanged (one provider per category for now). */
export default async function ConnectorsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const role = await getProjectRole(projectId);
  if (role !== "operator") notFound();

  const [connectors, project] = await Promise.all([listConnectors(projectId), getProject(projectId)]);
  const byType = new Map(connectors.map((c) => [c.type, c]));
  const neon = byType.get("neon");
  const r2 = byType.get("r2");
  // B2: sandboxes run on the shared planes — no dedicated DB/bucket to connect.
  const sandbox = project?.plan === "sandbox";

  const svcStatus = (type: string) => byType.get(type)?.status ?? "disconnected";
  const cats = [
    { id: "database", label: "Database", Icon: Database, provider: "Neon", status: sandbox ? "shared" : neon?.status ?? "disconnected" },
    { id: "storage", label: "Storage", Icon: HardDrive, provider: "R2", status: sandbox ? "shared" : r2?.status ?? "disconnected" },
    { id: "auth", label: "Auth", Icon: KeyRound, provider: "Clerk", status: svcStatus("clerk") },
    {
      id: "email",
      label: "Email",
      Icon: Mail,
      // Provider registry: the category names whichever provider is connected;
      // registry order is the tiebreak (same rule the resolver uses).
      provider: EMAIL_TYPES.find((t) => byType.get(t))
        ? CONNECTOR_SPECS[EMAIL_TYPES.find((t) => byType.get(t))!].label.replace(/ \(.*\)$/, "")
        : "Resend or Elastic Email",
      status: EMAIL_TYPES.some((t) => byType.get(t))
        ? svcStatus(EMAIL_TYPES.find((t) => byType.get(t))!)
        : "disconnected",
    },
    { id: "payments", label: "Payments", Icon: CreditCard, provider: "Stripe", status: svcStatus("stripe") },
  ];

  const formCard = (type: FormConnectorType) => {
    const spec = CONNECTOR_SPECS[type];
    const row = byType.get(type);
    return (
      <ConnectorCard
        projectId={projectId}
        type={type}
        label={spec.label}
        configFields={spec.configFields}
        secretLabel={spec.secretLabel}
        extraSecrets={spec.extraSecrets}
        storedSlots={Object.keys(row?.secretsEnc ?? {})}
        connected={Boolean(row)}
        hasSecret={Boolean(row?.secretEnc)}
        status={row?.status ?? "disconnected"}
        config={row?.config ?? {}}
      />
    );
  };

  return (
    <>
      <p className="eyebrow mb-1">Project</p>
      <h1 className="display mb-1 text-xl font-semibold">Connectors</h1>
      <p className="mb-5 max-w-lg text-sm text-ink-mute">
        Bring your own infrastructure — a database and bucket for the project, plus the services that power
        auth, email, and checkout. Secrets are encrypted at rest and never exposed to agents.
      </p>

      {/* Anchor + at-a-glance health row: jump to a category, see its status. */}
      <nav className="mb-9 flex flex-wrap gap-2">
        {cats.map((c) => (
          <a
            key={c.id}
            href={`#${c.id}`}
            className="inline-flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-1.5 text-[12.5px] text-ink-mute transition-colors hover:border-line-strong hover:text-ink"
          >
            <c.Icon className="h-3.5 w-3.5" />
            {c.label}
            <span
              className="h-[7px] w-[7px] rounded-full"
              style={{ background: statusColor(c.status) }}
              title={statusLabel(c.status)}
            />
          </a>
        ))}
      </nav>

      <div className="space-y-10">
        {cats.map((c) => (
          <section key={c.id} id={c.id} className="scroll-mt-[68px]">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-raised text-ink-mute">
                <c.Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="section-label leading-none">{c.label}</h2>
                <p className="mt-0.5 font-mono text-[11px] text-line-strong">{c.provider}</p>
              </div>
            </div>

            {c.id === "database" ? (
              sandbox ? (
                <SandboxNote what="database" />
              ) : (
                <NeonConnectorCard
                  projectId={projectId}
                  connected={Boolean(neon)}
                  status={neon?.status ?? "disconnected"}
                  host={neon?.config.host ?? null}
                  mode={neon?.config.mode ?? null}
                />
              )
            ) : c.id === "storage" ? (
              sandbox ? (
                <SandboxNote what="storage" />
              ) : (
                <R2ConnectorCard
                  projectId={projectId}
                  connected={Boolean(r2)}
                  status={r2?.status ?? "disconnected"}
                  bucket={r2?.config.bucket ?? null}
                  mode={r2?.config.mode ?? null}
                />
              )
            ) : c.id === "auth" ? (
              formCard("clerk")
            ) : c.id === "email" ? (
              <div className="flex flex-col gap-4">
                {EMAIL_TYPES.map((t) => (
                  <div key={t}>{formCard(t)}</div>
                ))}
              </div>
            ) : (
              formCard("stripe")
            )}
          </section>
        ))}
      </div>
    </>
  );
}

function SandboxNote({ what }: { what: "database" | "storage" }) {
  return (
    <div className="card max-w-md p-4 text-sm text-ink-mute">
      Sandbox projects run on the shared {what} — that&apos;s what makes them free. Upgrade to a paid project to
      give this one its own {what === "database" ? "database" : "bucket"}.
    </div>
  );
}

function statusColor(status: string): string {
  if (status === "connected") return "var(--color-accent)";
  if (status === "error") return "var(--color-err)";
  return "var(--color-line-strong)";
}

function statusLabel(status: string): string {
  if (status === "connected") return "connected";
  if (status === "error") return "error";
  if (status === "shared") return "shared plane";
  return "not connected";
}
