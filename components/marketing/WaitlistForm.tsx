"use client";

import { useState } from "react";
import { submitSignup } from "@/app/(marketing)/actions";
import { C } from "./atoms";

/**
 * Hostile Agent waitlist (teaser only — the product isn't built). Submits to
 * our own delivery API via the intake server action — LAUNCH-PLAN 0.2 dogfood.
 */
export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  return (
    <div className="mt-3 flex w-full max-w-[440px] flex-col gap-2">
      <form
        className="flex w-full gap-2.5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!email.trim() || state === "sending" || state === "sent") return;
          setState("sending");
          try {
            const res = await submitSignup({ email, product: "hostile-agent" });
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
        <input
          type="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (state !== "idle" && state !== "sending") setState("idle");
          }}
          placeholder="you@yourcompany.com"
          className="mkt-waitlist-input flex-1 rounded-[4px] px-4 py-3.5 font-mono text-[13px] outline-none"
          style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.14)`, color: C.ink }}
        />
        <button
          type="submit"
          disabled={state === "sending"}
          className="mkt-cta whitespace-nowrap rounded-[4px] px-[22px] py-3.5 font-mono text-[13px] font-semibold disabled:opacity-60"
        >
          {state === "sent" ? "✓ on the list" : state === "sending" ? "sending…" : "Join waitlist"}
        </button>
      </form>
      {state === "error" && (
        <span className="font-mono text-[11px]" style={{ color: C.err }}>
          {error}
        </span>
      )}
    </div>
  );
}
