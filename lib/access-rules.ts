import type { Collection } from "@/db/schema";
import { verifyEndUser, type EndUser } from "./user-auth";
import type { WhereClause } from "./query";

/**
 * Phase 4 rule presets — the delivery API's identity gate. Three levels, no
 * expression language:
 *
 *   read:  public (default) | authenticated | owner
 *   write: none (default — publicWrite governs anonymous forms)
 *          | authenticated (signed-in users may CREATE; ownerField stamped)
 *          | owner (create like authenticated, plus UPDATE/DELETE of own rows)
 *
 * `owner` rows are matched via ownerField (a text field holding the verified
 * JWT sub). publicRead on fields still controls the projection: it means
 * "exposed through the delivery API when the row gate passes".
 */

export type Gate =
  | { ok: true; user: EndUser | null; ownerClause?: WhereClause }
  | { ok: false; status: number; error: string };

function denied(status: number, error: string): Gate {
  return { ok: false, status, error };
}

export async function gateRead(
  projectId: string,
  collection: Collection,
  userToken: string | null,
): Promise<Gate> {
  const rule = collection.access?.read ?? "public";
  if (rule === "public") return { ok: true, user: null };

  const auth = await verifyEndUser(projectId, userToken);
  if (auth.status === "unconfigured") {
    return denied(503, "this project has no auth issuer connected (Clerk connector)");
  }
  if (auth.status === "none") {
    return denied(401, "sign-in required: pass the user's JWT in the X-User-Token header");
  }
  if (auth.status === "invalid") return denied(401, `invalid user token: ${auth.reason}`);

  if (rule === "owner") {
    const ownerField = collection.access?.ownerField;
    if (!ownerField) return denied(500, "collection misconfigured: owner rule without ownerField");
    return {
      ok: true,
      user: auth.user,
      ownerClause: { field: ownerField, op: "eq", value: auth.user.id },
    };
  }
  return { ok: true, user: auth.user };
}

export async function gateCreate(
  projectId: string,
  collection: Collection,
  userToken: string | null,
): Promise<Gate> {
  const rule = collection.access?.write ?? "none";

  // No identity rule: anonymous forms via publicWrite, exactly as before.
  if (rule === "none") {
    if (collection.publicWrite) return { ok: true, user: null };
    return denied(403, "public write is not enabled for this collection");
  }

  const auth = await verifyEndUser(projectId, userToken);
  if (auth.status === "unconfigured") {
    return denied(503, "this project has no auth issuer connected (Clerk connector)");
  }
  if (auth.status !== "ok") {
    return denied(
      401,
      auth.status === "none"
        ? "sign-in required: pass the user's JWT in the X-User-Token header"
        : `invalid user token: ${auth.reason}`,
    );
  }
  return { ok: true, user: auth.user };
}

/** update/delete are allowed ONLY under write:"owner", only on own rows. */
export async function gateMutate(
  projectId: string,
  collection: Collection,
  userToken: string | null,
  entryData: Record<string, unknown>,
): Promise<Gate> {
  if ((collection.access?.write ?? "none") !== "owner") {
    return denied(403, 'entry mutation via delivery API requires write: "owner"');
  }
  const gate = await gateCreate(projectId, collection, userToken);
  if (!gate.ok) return gate;
  const ownerField = collection.access?.ownerField;
  if (!ownerField) return denied(500, "collection misconfigured: owner rule without ownerField");
  if (!gate.user || entryData[ownerField] !== gate.user.id) {
    // 404 not 403: don't confirm the row exists to non-owners.
    return denied(404, "not found");
  }
  return gate;
}

/** Force the ownerField to the verified user on authenticated creates. */
export function stampOwner(
  collection: Collection,
  user: EndUser | null,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const ownerField = collection.access?.ownerField;
  if (!ownerField || !user) return data;
  return { ...data, [ownerField]: user.id };
}
