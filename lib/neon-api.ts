import "server-only";

/**
 * Minimal Neon control-API client for MANAGED provisioning (A3): one Neon
 * project per tenant project, created in OUR org with the platform's org API
 * key. Only the three calls the state machine needs — create, readiness poll,
 * delete. The base URL comes from NEON_API_BASE so the smoke harness can point
 * it at a local mock (the STRIPE_API_BASE precedent); unset = the real API.
 *
 * Platform env:
 * - NEON_API_KEY   (required for managed provisioning; BYO works without it)
 * - NEON_ORG_ID    (required when the key is a personal key; org keys omit it)
 * - NEON_REGION    (default aws-us-east-1 — same region as the Render service)
 * - NEON_API_BASE  (tests only)
 */

const API_BASE = () => process.env.NEON_API_BASE || "https://console.neon.tech/api/v2";
const PG_VERSION = 18;

function apiKey(): string {
  const key = process.env.NEON_API_KEY;
  if (!key) {
    throw new Error(
      "NEON_API_KEY is not set — managed provisioning needs the platform's Neon org API key (BYO connections are unaffected)",
    );
  }
  return key;
}

async function neonFetch(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Neon API ${init.method ?? "GET"} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Neon API ${path} returned non-JSON (HTTP ${res.status})`);
  }
}

export interface CreatedNeonProject {
  neonProjectId: string;
  /** Connection string with credentials — returned ONLY at creation time. */
  connectionUri: string;
}

/** Create the tenant's Neon project. Async on Neon's side — call
 *  waitForNeonProject before first connect. */
export async function createNeonProject(name: string): Promise<CreatedNeonProject> {
  const body: Record<string, unknown> = {
    project: {
      name,
      pg_version: PG_VERSION,
      region_id: process.env.NEON_REGION || "aws-us-east-1",
      ...(process.env.NEON_ORG_ID ? { org_id: process.env.NEON_ORG_ID } : {}),
    },
  };
  const resp = await neonFetch("/projects", { method: "POST", body: JSON.stringify(body) });
  const project = resp.project as { id?: string } | undefined;
  const uris = resp.connection_uris as { connection_uri?: string }[] | undefined;
  const id = project?.id;
  const uri = uris?.[0]?.connection_uri;
  if (!id || !uri) {
    throw new Error("Neon API create-project response is missing project.id or connection_uris");
  }
  return { neonProjectId: id, connectionUri: uri };
}

/** Poll the project's operations until all are finished (creation is async). */
export async function waitForNeonProject(neonProjectId: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const resp = await neonFetch(`/projects/${neonProjectId}/operations`);
    const ops = (resp.operations as { status?: string; action?: string }[] | undefined) ?? [];
    const failed = ops.find((o) => o.status === "failed" || o.status === "error");
    if (failed) {
      throw new Error(`Neon operation ${failed.action ?? "?"} failed while provisioning ${neonProjectId}`);
    }
    if (ops.every((o) => o.status === "finished")) return;
    if (Date.now() > deadline) {
      throw new Error(`Neon project ${neonProjectId} still provisioning after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Per-project consumption for the CURRENT billing period, read straight off
 * the project object (Track 4b). Broadly available — unlike the time-series
 * /consumption_history endpoints (Scale+ only), which we don't need to bill:
 * we snapshot these totals daily and diff. Missing fields read as 0 so a
 * Neon-side shape change degrades to "no data", never a crash.
 */
export interface NeonProjectConsumption {
  computeTimeSeconds: number;
  activeTimeSeconds: number;
  writtenDataBytes: number;
  dataStorageBytesHour: number;
  syntheticStorageSizeBytes: number;
  consumptionPeriodStart: string | null;
}

export async function getNeonProjectConsumption(neonProjectId: string): Promise<NeonProjectConsumption> {
  const resp = await neonFetch(`/projects/${neonProjectId}`);
  const p = (resp.project ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    computeTimeSeconds: num(p.compute_time_seconds),
    activeTimeSeconds: num(p.active_time_seconds),
    writtenDataBytes: num(p.written_data_bytes),
    dataStorageBytesHour: num(p.data_storage_bytes_hour),
    syntheticStorageSizeBytes: num(p.synthetic_storage_size),
    consumptionPeriodStart:
      typeof p.consumption_period_start === "string" ? p.consumption_period_start : null,
  };
}

/**
 * Delete the tenant's Neon project (managed teardown). A 404 is success — the
 * project is already gone, and retries after a network blip must not wedge
 * (Neon-side deletion is recoverable for 7 days via their console/API, so an
 * accidental teardown has a grace window).
 */
export async function deleteNeonProject(neonProjectId: string): Promise<void> {
  try {
    await neonFetch(`/projects/${neonProjectId}`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof Error && /HTTP 404/.test(e.message)) return;
    throw e;
  }
}
