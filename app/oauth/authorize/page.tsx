import { redirect } from "next/navigation";
import { getViewer } from "@/lib/access";
import { listViewerWorkspaces, projectsInWorkspace } from "@/lib/workspaces";
import { getClient, redirectUriAllowed, resourceAcceptable, canonicalMcpResource } from "@/lib/oauth";
import { MCP_SCOPES, DEFAULT_CONSENT_SCOPES, ALL_SCOPES, type McpScope } from "@/lib/scopes";
import { originFromHeaders } from "@/lib/origin";
import { headers } from "next/headers";
import { ConsentForm } from "./consent-form";

/**
 * DX-6 / D3 — the consent screen. This is the whole point of OAuth for us: the
 * moment a human, not a config file, decides which project an agent may touch
 * and what it may do there.
 *
 * It also ends the wrong-project error class by construction. Today a token is
 * an opaque string whose project you cannot see (a live mistake: an agent
 * minted into the wrong project because five credentials on one machine were
 * indistinguishable). Here the project is chosen BY NAME, by a person, at
 * connect time.
 *
 * Error handling follows OAuth 2.1 §7.12.2: parameter problems we cannot trust
 * are rendered, NEVER redirected. Redirecting an unvalidated redirect_uri is
 * the open-redirect hole itself.
 */
export const dynamic = "force-dynamic";

function ErrorPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <div className="card p-6">
        <p className="eyebrow mb-1 text-err">Authorization error</p>
        <h1 className="display mb-2 text-lg font-semibold">{title}</h1>
        <p className="text-sm text-ink-mute">{detail}</p>
        <p className="mt-4 text-xs text-ink-mute">
          Nothing was authorized. You can close this window.
        </p>
      </div>
    </main>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));

  const clientId = one("client_id");
  const redirectUri = one("redirect_uri");
  const responseType = one("response_type");
  const codeChallenge = one("code_challenge");
  const codeChallengeMethod = one("code_challenge_method");
  const state = one("state");
  const resource = one("resource") ?? null;
  const requestedScope = one("scope");

  // ── Validate everything we must NOT redirect on ────────────────────────
  if (!clientId || !redirectUri) {
    return <ErrorPanel title="Missing parameters" detail="client_id and redirect_uri are required." />;
  }
  const client = await getClient(clientId);
  if (!client) {
    return <ErrorPanel title="Unknown client" detail="This client_id is not registered. Register first, then retry." />;
  }
  if (!redirectUriAllowed(client.redirectUris, redirectUri)) {
    // Deliberately rendered, not redirected — an unregistered redirect target
    // is exactly what an attacker supplies.
    return (
      <ErrorPanel
        title="Redirect URI not registered"
        detail="This redirect_uri is not on the client's allowlist, so no code will be issued."
      />
    );
  }

  const hdrs = await headers();
  const origin = originFromHeaders((n) => hdrs.get(n)) ?? "";

  // ── From here, protocol errors CAN safely go back to the client ────────
  const bounce = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    redirect(u.toString());
  };

  if (responseType !== "code") bounce("unsupported_response_type", "only response_type=code is supported");
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    bounce("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256");
  }
  if (!resourceAcceptable(resource, origin)) {
    bounce("invalid_target", `resource must be ${canonicalMcpResource(origin)}`);
  }

  const asked = (requestedScope ?? "").split(/\s+/).filter(Boolean);
  const unknown = asked.filter((s) => !ALL_SCOPES.includes(s as McpScope));
  if (unknown.length) bounce("invalid_scope", `unknown scope(s): ${unknown.join(", ")}`);

  // ── The human ──────────────────────────────────────────────────────────
  const viewer = await getViewer();
  if (!viewer) {
    const back = `/oauth/authorize?${new URLSearchParams(
      Object.entries(sp).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v[0] : v] as [string, string]])),
    )}`;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(back)}`);
  }

  const workspaces = await listViewerWorkspaces(viewer!.userId);
  const grouped = await Promise.all(
    workspaces.map(async (w) => ({
      workspace: w.name,
      projects: (await projectsInWorkspace(w.id)).map((p) => ({
        id: p.id,
        name: p.branding?.displayName ?? p.name,
        status: p.status,
      })),
    })),
  );
  const selectable = grouped.filter((g) => g.projects.length > 0);

  if (selectable.length === 0) {
    return (
      <ErrorPanel
        title="No projects to authorize"
        detail="This account has no projects yet. Create one in the dashboard, then run the connection again."
      />
    );
  }

  // Pre-check what the client asked for; otherwise the safe default set.
  const preselected = asked.length ? (asked as McpScope[]) : DEFAULT_CONSENT_SCOPES;

  return (
    <ConsentForm
      clientName={client.clientName ?? clientId}
      clientUri={client.clientUri}
      groups={selectable}
      scopes={ALL_SCOPES.map((s) => ({ id: s, label: MCP_SCOPES[s], preselected: preselected.includes(s) }))}
      hidden={{
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge!,
        state: state ?? "",
        resource: resource ?? "",
      }}
    />
  );
}
