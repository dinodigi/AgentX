"use client";

import { useState } from "react";
import { C } from "./atoms";

/**
 * Hostile Agent waitlist (teaser only — the product isn't built). Captures an
 * email locally and confirms; wire to a real list endpoint when one exists.
 */
export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [joined, setJoined] = useState(false);
  return (
    <form
      className="mt-3 flex w-full max-w-[440px] gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (email.trim()) setJoined(true);
      }}
    >
      <input
        type="email"
        required
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setJoined(false);
        }}
        placeholder="you@yourcompany.com"
        className="mkt-waitlist-input flex-1 rounded-[4px] px-4 py-3.5 font-mono text-[13px] outline-none"
        style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.14)`, color: C.ink }}
      />
      <button
        type="submit"
        className="mkt-cta whitespace-nowrap rounded-[4px] px-[22px] py-3.5 font-mono text-[13px] font-semibold"
      >
        {joined ? "✓ on the list" : "Join waitlist"}
      </button>
    </form>
  );
}
