"use client";

import { useState } from "react";
import { submitSignup } from "@/app/(marketing)/actions";
import { C } from "./atoms";

/**
 * Beta-access request (Pricing.dc.html). Submits to our own delivery API via
 * the intake server action — LAUNCH-PLAN 0.2 dogfood: leads land in the
 * Pluggie Marketing project's signups inbox.
 */
export function BetaRequestForm() {
  const [email, setEmail] = useState("");
  const [about, setAbout] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const field = "rounded-[4px] px-4 py-3.5 font-mono text-[13px] outline-none mkt-waitlist-input";
  const fieldStyle = { background: C.panel, border: `1px solid rgba(255,255,255,0.14)`, color: C.ink } as const;
  const reset = () => {
    if (state !== "idle" && state !== "sending") setState("idle");
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!email.trim() || state === "sending" || state === "sent") return;
        setState("sending");
        try {
          const res = await submitSignup({ email, product: "agentx", about });
          if (res.ok) {
            setState("sent");
          } else {
            setError(res.error);
            setState("error");
          }
        } catch {
          setError("Network hiccup — try again.");
          setState("error");
        }
      }}
    >
      <h2 className="m-0 text-[22px] font-bold tracking-[-0.02em]">Request a spot</h2>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => { setEmail(e.target.value); reset(); }}
        placeholder="work email"
        className={field}
        style={fieldStyle}
      />
      <textarea
        value={about}
        onChange={(e) => { setAbout(e.target.value); reset(); }}
        placeholder="what will you build with it? one or two lines is plenty"
        rows={4}
        className={`${field} resize-y`}
        style={fieldStyle}
      />
      <button
        type="submit"
        disabled={state === "sending"}
        className="mkt-cta rounded-[4px] px-6 py-[15px] font-mono text-[13px] font-semibold disabled:opacity-60"
      >
        {state === "sent" ? "✓ request sent" : state === "sending" ? "sending…" : "Become a beta tester"}
      </button>
      {state === "error" && (
        <span className="font-mono text-[11px]" style={{ color: C.err }}>
          {error}
        </span>
      )}
      <span className="font-mono text-[11px]" style={{ color: C.faint }}>
        we reply to every request, usually within a couple of days
      </span>
    </form>
  );
}
