"use client";

import { useState } from "react";
import { C } from "./atoms";

/**
 * Beta-access request (Pricing.dc.html). Local-only for the private beta — wire
 * to a real intake endpoint (or an email) when one exists.
 */
export function BetaRequestForm() {
  const [email, setEmail] = useState("");
  const [about, setAbout] = useState("");
  const [sent, setSent] = useState(false);
  const field = "rounded-[4px] px-4 py-3.5 font-mono text-[13px] outline-none mkt-waitlist-input";
  const fieldStyle = { background: C.panel, border: `1px solid rgba(255,255,255,0.14)`, color: C.ink } as const;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (email.trim()) setSent(true);
      }}
    >
      <h2 className="m-0 text-[22px] font-bold tracking-[-0.02em]">Request a spot</h2>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => { setEmail(e.target.value); setSent(false); }}
        placeholder="work email"
        className={field}
        style={fieldStyle}
      />
      <textarea
        value={about}
        onChange={(e) => { setAbout(e.target.value); setSent(false); }}
        placeholder="what will you build with it? one or two lines is plenty"
        rows={4}
        className={`${field} resize-y`}
        style={fieldStyle}
      />
      <button type="submit" className="mkt-cta rounded-[4px] px-6 py-[15px] font-mono text-[13px] font-semibold">
        {sent ? "✓ request sent" : "Become a beta tester"}
      </button>
      <span className="font-mono text-[11px]" style={{ color: C.faint }}>
        we reply to every request, usually within a couple of days
      </span>
    </form>
  );
}
