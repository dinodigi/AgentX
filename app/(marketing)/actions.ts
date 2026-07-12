"use server";

import { headers } from "next/headers";

/**
 * LAUNCH-PLAN 0.2 — marketing intake, dogfooded on AgentX itself.
 *
 * The waitlist/beta forms submit here; we forward to our own delivery API
 * exactly like a customer site's server would — bearer delivery token
 * (server-side only; delivery tokens are never browser-safe).
 *
 * SECURITY: the bearer must never leave this machine, so the request target is
 * pinned to a trusted value (APP_URL, else a loopback to our own port) — NEVER
 * derived from the untrusted Host/X-Forwarded-* headers. We also do NOT echo
 * the visitor's X-Forwarded-For (its leftmost entry is client-controlled, so
 * forwarding it would let a script rotate spoofed IPs to defeat the delivery
 * rate limiter). Omitting it means all marketing signups share one 20/min
 * bucket, which fails safe; a real per-visitor cap arrives with the durable
 * rate-limit store (LAUNCH-PLAN C2).
 */
export type IntakeResult = { ok: true } | { ok: false; error: string };

const PRODUCTS = new Set(["agentx", "hostile-agent"]);
const TRY_AGAIN = "Something went wrong on our side — try again shortly.";
const ABOUT_MAX = 2000;

/** A trusted self-URL for the loopback call. Never uses request-supplied hosts. */
function selfBase(h: Headers): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  // Fall back to a loopback on our own listen port so the bearer stays on-box.
  // Render sets PORT for `next start`; in dev we read the port (only) from the
  // incoming Host, with the hostname forced to loopback.
  const envPort = process.env.PORT;
  const hostPort = (h.get("host") ?? "").split(":")[1];
  const port =
    (envPort && /^\d+$/.test(envPort) && envPort) ||
    (hostPort && /^\d+$/.test(hostPort) && hostPort) ||
    "3000";
  return `http://127.0.0.1:${port}`;
}

/** Trim to ABOUT_MAX UTF-16 units without leaving a split surrogate pair. */
function clampAbout(v: string): string {
  let s = v.trim().slice(0, ABOUT_MAX);
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1); // drop a lone high surrogate
  return s;
}

export async function submitSignup(input: {
  email: string;
  product: string;
  about?: string;
}): Promise<IntakeResult> {
  const token = process.env.MARKETING_INTAKE_TOKEN;
  if (!token) {
    console.error("MARKETING_INTAKE_TOKEN is not set — marketing signup dropped");
    return { ok: false, error: "Signups aren't wired up in this environment yet." };
  }

  const email = (input.email ?? "").trim();
  if (!email) return { ok: false, error: "Enter your email first." };
  if (!PRODUCTS.has(input.product)) return { ok: false, error: TRY_AGAIN };
  const about = clampAbout(input.about ?? "");

  const h = await headers();
  const base = selfBase(h);

  try {
    // Forward the visitor's IP chain — without it every signup shares the
    // server's own rate-limit bucket (C2 made that bucket durable, which
    // would turn >20 signups/min GLOBALLY into 429s for real visitors).
    const xff = h.get("x-forwarded-for");
    const res = await fetch(`${base}/api/v1/signups`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(xff ? { "x-forwarded-for": xff } : {}),
      },
      body: JSON.stringify({ email, product: input.product, ...(about ? { about } : {}) }),
      cache: "no-store",
    });

    if (res.status === 201) return { ok: true };

    const body = await res.json().catch(() => null);
    if (res.status === 422) {
      const emailIssue = body?.issues?.some((i: { field?: string }) => i.field === "email");
      return {
        ok: false,
        error: emailIssue
          ? "That email doesn't look right — check it and try again."
          : "Something in the form didn't validate — check it and try again.",
      };
    }
    if (res.status === 429) {
      return { ok: false, error: "Too many submissions right now — try again in a minute." };
    }
    console.error("marketing intake failed", res.status, body);
    return { ok: false, error: TRY_AGAIN };
  } catch (e) {
    console.error("marketing intake unreachable", e);
    return { ok: false, error: TRY_AGAIN };
  }
}
