import "server-only";
import { eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";
import { controlDb } from "@/db";
import { projects } from "@/db/schema";
import { generateToken, hashToken } from "./tokens";
import { getCollection } from "./collections";
import { createEntry } from "./entries";
import { ValidationError } from "./validation";

/**
 * 2b inbound email: route a mail provider's parsed-inbound POST into a
 * collection. Provider-agnostic — the operator points Resend/SES/Postmark/
 * Mailgun inbound-parse at POST /api/inbound/{projectId} with a per-project
 * secret and a NORMALIZED body {from,to,subject,text,html?}. We verify the
 * secret, map the fields, and create the entry on the TRUSTED path (bypasses
 * publicWrite gating — the secret is the auth), so a customer reply threads
 * back natively instead of the tenant building their own webhook.
 */

const INBOUND_FIELDS = ["from", "to", "subject", "text", "html"] as const;
type InboundField = (typeof INBOUND_FIELDS)[number];

export interface InboundConfigView {
  collectionName: string;
  fieldMap: Record<string, string>;
}

/** Configure inbound routing; returns the secret ONCE (only its hash is stored). */
export async function configureInbound(
  projectId: string,
  input: { collection: string; fieldMap: Record<string, string> },
): Promise<{ secret: string; postUrl: string }> {
  const collection = await getCollection(projectId, input.collection);
  if (!collection) throw new ValidationError(`unknown collection "${input.collection}"`, "E_NOT_FOUND");

  const map = input.fieldMap ?? {};
  const entries = Object.entries(map);
  if (entries.length === 0) {
    throw new ValidationError(
      "fieldMap needs at least one mapping, e.g. {from:'email', subject:'subject', text:'message'}",
    );
  }
  const fieldNames = new Set(collection.fields.map((f) => f.name));
  for (const [inb, target] of entries) {
    if (!INBOUND_FIELDS.includes(inb as InboundField)) {
      throw new ValidationError(`fieldMap key "${inb}" — inbound fields are: ${INBOUND_FIELDS.join(", ")}`);
    }
    if (!fieldNames.has(target)) {
      throw new ValidationError(`fieldMap maps to "${target}", which is not a field on "${input.collection}"`);
    }
  }

  const secret = generateToken();
  await controlDb
    .update(projects)
    .set({ inboundConfig: { collectionName: input.collection, secretHash: hashToken(secret), fieldMap: map } })
    .where(eq(projects.id, projectId));
  revalidateTag(`project:${projectId}`);
  const base = process.env.APP_URL?.replace(/\/$/, "") ?? "https://pluggie.app";
  return { secret, postUrl: `${base}/api/inbound/${projectId}` };
}

export async function disableInbound(projectId: string): Promise<void> {
  await controlDb.update(projects).set({ inboundConfig: null }).where(eq(projects.id, projectId));
  revalidateTag(`project:${projectId}`);
}

export async function getInboundConfig(projectId: string): Promise<InboundConfigView | null> {
  const cfg = await readInboundConfig(projectId);
  return cfg ? { collectionName: cfg.collectionName, fieldMap: cfg.fieldMap } : null;
}

/**
 * FRESH read (no cache) of the inbound config. Deliberate: inbound is a
 * security-gated sink, so a `disable_inbound` must take effect IMMEDIATELY
 * (revoking access can't lag a cache TTL), and receipt is infrequent enough
 * that a per-message control-DB read is cheap.
 */
async function readInboundConfig(projectId: string) {
  const [row] = await controlDb
    .select({ cfg: projects.inboundConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.cfg ?? null;
}

function secretMatches(provided: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(provided));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Receive one inbound message. Returns the created entry id. Fail-closed:
 * unconfigured project or wrong secret → null (the route maps to 404/401 so a
 * probe can't distinguish "off" from "wrong key").
 */
export async function receiveInbound(
  projectId: string,
  providedSecret: string | null,
  payload: Record<string, unknown>,
): Promise<{ ok: true; id: string } | { ok: false; reason: "unconfigured" | "unauthorized" | "error"; detail?: string }> {
  const cfg = await readInboundConfig(projectId);
  if (!cfg) return { ok: false, reason: "unconfigured" };
  if (!providedSecret || !secretMatches(providedSecret, cfg.secretHash)) {
    return { ok: false, reason: "unauthorized" };
  }

  const collection = await getCollection(projectId, cfg.collectionName);
  if (!collection) return { ok: false, reason: "error", detail: "routed collection no longer exists" };

  const data: Record<string, unknown> = {};
  for (const [inb, target] of Object.entries(cfg.fieldMap)) {
    const v = payload[inb];
    if (typeof v === "string") data[target] = v;
  }

  try {
    const entry = await createEntry(projectId, collection, data, { actor: { type: "inbound" } });
    return { ok: true, id: entry.id };
  } catch (e) {
    // Validation failure (e.g. a required field the provider didn't send) is
    // the tenant's mapping issue — surface it so they can fix the map.
    return { ok: false, reason: "error", detail: e instanceof Error ? e.message : "create failed" };
  }
}
