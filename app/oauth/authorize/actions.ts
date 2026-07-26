"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getViewer, getProjectRole } from "@/lib/access";
import { getClient, redirectUriAllowed, issueCode, resourceAcceptable } from "@/lib/oauth";
import { ALL_SCOPES, type McpScope } from "@/lib/scopes";
import { originFromHeaders } from "@/lib/origin";
import { recordPlatformEvent } from "@/lib/platform-events";
import { getProject } from "@/lib/admin";

/**
 * Turn an approved consent into an authorization code.
 *
 * Every parameter is RE-VALIDATED here rather than trusted from the form. The
 * page validated them to decide what to render; this action is a separate HTTP
 * request and a form post is fully attacker-controlled. In particular the
 * redirect_uri is re-checked against the client's allowlist — trusting the
 * posted value would reintroduce the open-redirect hole the page closed.
 */
export async function approveAuthorization(formData: FormData): Promise<void> {
  const get = (k: string) => String(formData.get(k) ?? "");
  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const codeChallenge = get("code_challenge");
  const state = get("state");
  const resource = get("resource") || null;
  const projectId = get("project_id");
  const scopes = get("scopes").split(/\s+/).filter(Boolean);
  const denied = get("deny") === "1";

  const client = await getClient(clientId);
  if (!client || !redirectUriAllowed(client.redirectUris, redirectUri)) {
    // Never redirect to an unvalidated URI — fail closed and visibly.
    throw new Error("invalid client or redirect_uri");
  }

  const back = (params: Record<string, string>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (state) u.searchParams.set("state", state);
    redirect(u.toString());
  };

  if (denied) back({ error: "access_denied", error_description: "the user declined the request" });

  const viewer = await getViewer();
  if (!viewer) back({ error: "access_denied", error_description: "not signed in" });

  // AUTHORIZATION, not just authentication: being signed in does not mean this
  // person may grant access to THIS project. Re-check the access ladder.
  const role = await getProjectRole(projectId);
  if (!role) back({ error: "access_denied", error_description: "no access to the selected project" });

  const unknown = scopes.filter((s) => !ALL_SCOPES.includes(s as McpScope));
  if (unknown.length) back({ error: "invalid_scope", error_description: `unknown scope(s): ${unknown.join(", ")}` });
  if (scopes.length === 0) back({ error: "invalid_scope", error_description: "at least one scope is required" });

  const hdrs = await headers();
  const origin = originFromHeaders((n) => hdrs.get(n)) ?? "";
  if (!resourceAcceptable(resource, origin)) {
    back({ error: "invalid_target", error_description: "resource does not identify this MCP server" });
  }

  const code = await issueCode({
    clientId,
    redirectUri,
    codeChallenge,
    resource,
    projectId,
    scopes,
    approvedBy: viewer!.userId,
  });

  // The tenant-visible trail: who authorized what, for which client. A consent
  // that leaves no record is a consent nobody can audit later.
  const project = await getProject(projectId);
  recordPlatformEvent({
    projectId,
    projectName: project?.branding?.displayName ?? "?",
    type: "oauth_grant",
    actorEmail: viewer!.email,
    note: `authorized "${client.clientName ?? clientId}" with scopes: ${scopes.join(", ")}`,
  });

  back({ code });
}
