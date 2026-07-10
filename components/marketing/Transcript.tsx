"use client";

import { useEffect, useState } from "react";
import { C } from "./atoms";

/**
 * The live hero transcript (Landing.dc.html) — our signature "agent ▸ / agentx ◂"
 * voice. Lines type in on a loop, a green caret blinks, then it resets. Real
 * mechanics as imagery: an agent hits a validation error and repairs itself
 * from the hint alone.
 */
const LINES: { pre: string; text: string; color: string }[] = [
  { pre: "agent ▸ ", text: 'define_collection({ name: "products", fields: … })', color: C.ink },
  { pre: "agentx ◂ ", text: 'ok · collection "products" created (7 fields)', color: C.accent },
  { pre: "agent ▸ ", text: "create_entry({ price: -4 })", color: C.ink },
  { pre: "agentx ◂ ", text: 'E_VALIDATION · price: min 0 · hint: "must be ≥ 0"', color: C.err },
  { pre: "agent ▸ ", text: "create_entry({ price: 49 })  // repaired from hint", color: C.ink },
  { pre: "agentx ◂ ", text: "ok · id ent_x92 · admin + /v1/products live", color: C.accent },
];

export function Transcript() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(
      () => setStep((s) => (s >= LINES.length + 3 ? 0 : s + 1)),
      1100,
    );
    return () => clearInterval(t);
  }, []);

  const shown = Math.min(step, LINES.length);
  return (
    <div
      className="overflow-hidden rounded-lg"
      style={{ background: C.panel, border: `1px solid rgba(255,255,255,0.1)`, boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: `1px solid ${C.line}`, background: C.panelHead }}
      >
        <span className="font-mono text-[11px]" style={{ color: C.faint }}>
          mcp · agentx
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[10px]" style={{ color: C.accent }}>
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: C.accent, animation: "pulse-dot 2s ease infinite" }}
          />
          connected
        </span>
      </div>
      <div className="min-h-[300px] p-5 font-mono text-[12.5px] leading-[1.85]">
        {LINES.slice(0, shown).map((l, i) => (
          <div key={i} style={{ animation: "fade-line 0.4s ease" }}>
            <span style={{ color: C.faint }}>{l.pre}</span>
            <span style={{ color: l.color }}>{l.text}</span>
          </div>
        ))}
        <div>
          <span style={{ color: C.faint }}>{shown >= LINES.length ? "agent ▸ " : ""}</span>
          <span
            className="inline-block align-text-bottom"
            style={{ width: "8px", height: "15px", background: C.accent, animation: "blink 1s step-end infinite" }}
          />
        </div>
      </div>
    </div>
  );
}
