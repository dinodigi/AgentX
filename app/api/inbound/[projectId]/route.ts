import { NextRequest } from "next/server";
import { bearerFrom } from "@/lib/tokens";
import { receiveInbound } from "@/lib/inbound";
import { rateLimit } from "@/lib/ratelimit";
import { readBounded, MAX_DELIVERY_BODY_BYTES } from "@/lib/http";

/**
 * 2b inbound email sink. A mail provider (Resend/SES/Postmark/Mailgun inbound
 * parse) POSTs a normalized {from,to,subject,text,html?} here with the
 * per-project inbound secret as a bearer token. Fail-closed: an unconfigured
 * project and a wrong secret are indistinguishable to a prober (404 vs 401
 * both reveal nothing routable). Routed entry creation is trusted (the secret
 * is the auth), so this bypasses publicWrite — but ONLY into the configured
 * collection with the configured field map.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const rl = await rateLimit(`${projectId}:${ip}`, { projectId });
  if (!rl.allowed) {
    return json(429, { error: "too many inbound messages — try again shortly", code: "E_RATE_LIMITED" });
  }

  const raw = await readBounded(req, MAX_DELIVERY_BODY_BYTES);
  if (raw === null) return json(413, { error: "request body too large", code: "E_VALIDATION" });
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid JSON body", code: "E_VALIDATION" });
  }

  const secret = bearerFrom(req.headers.get("authorization"));
  const result = await receiveInbound(projectId, secret, payload);
  if (result.ok) return json(201, { id: result.id });
  if (result.reason === "unconfigured") return json(404, { error: "not found", code: "E_NOT_FOUND" });
  if (result.reason === "unauthorized") return json(401, { error: "invalid inbound secret", code: "E_AUTH" });
  return json(422, { error: result.detail ?? "could not route message", code: "E_VALIDATION" });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
