import { notFound } from "next/navigation";
import { getProjectRole } from "@/lib/access";
import { listConnectors, CONNECTOR_SPECS, type FormConnectorType } from "@/lib/connectors";
import { ConnectorCard, NeonConnectorCard } from "../settings/sections";

/** Connectors tab — the project's bring-your-own infrastructure. Operator-only. */
export default async function ConnectorsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const role = await getProjectRole(projectId);
  if (role !== "operator") notFound();

  const connectors = await listConnectors(projectId);
  const byType = new Map(connectors.map((c) => [c.type, c]));
  const neon = byType.get("neon");

  return (
    <>
      <p className="eyebrow mb-1">Project</p>
      <h1 className="display mb-1 text-xl font-semibold">Connectors</h1>
      <p className="mb-6 max-w-md text-sm text-ink-mute">
        Bring your own infrastructure. Neon gives the project its own database;
        Clerk powers end-user sign-in and access rules; Resend powers email
        actions; Stripe powers checkout. Secrets are encrypted at rest and never
        exposed to agents.
      </p>
      <div className="space-y-4">
        <NeonConnectorCard
          projectId={projectId}
          connected={Boolean(neon)}
          status={neon?.status ?? "disconnected"}
          host={neon?.config.host ?? null}
          mode={neon?.config.mode ?? null}
        />
        {(Object.keys(CONNECTOR_SPECS) as FormConnectorType[]).map((type) => {
          const spec = CONNECTOR_SPECS[type];
          const row = byType.get(type);
          return (
            <ConnectorCard
              key={type}
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
        })}
      </div>
    </>
  );
}
