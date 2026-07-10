"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { C } from "./atoms";

/**
 * Marketing top nav (Direction / Nav.dc.html). Pluggie mark + product-family
 * menu, sticky with a blur. Active section derives from the pathname so the
 * current silo is highlighted green.
 */
export function Nav() {
  const pathname = usePathname() || "/";
  const [open, setOpen] = useState(false);

  const active = (seg: string) =>
    seg === "products"
      ? pathname.startsWith("/product") || pathname.startsWith("/hostile-agent")
      : pathname.startsWith(`/${seg}`);
  const linkColor = (seg: string) => (active(seg) ? C.accent : "#C7CCC9");

  const items: [string, string][] = [
    ["solutions", "Solutions"],
    ["developers", "Developers"],
    ["pricing", "Pricing"],
    ["company", "Company"],
  ];

  return (
    <nav
      className="sticky top-0 z-50 flex min-h-16 flex-wrap items-center justify-between gap-y-1 border-b px-6 py-2"
      style={{
        background: "rgba(10,11,13,0.82)",
        backdropFilter: "blur(12px)",
        borderColor: C.line,
      }}
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
        <Link href="/" className="flex items-center gap-2.5" style={{ color: C.ink }}>
          <span className="inline-block h-3.5 w-3.5 rounded-[2px]" style={{ background: C.accent }} />
          <span className="text-[17px] font-semibold tracking-[-0.01em]">Pluggie</span>
        </Link>
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <div
            className="relative"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
          >
            <Link
              href="/products"
              className="flex items-center gap-1.5 rounded-[4px] px-3 py-2 hover:bg-[rgba(255,255,255,0.05)]"
              style={{ color: linkColor("products") }}
            >
              Products <span className="text-[9px]" style={{ color: C.faint }}>▾</span>
            </Link>
            {open && (
              <div
                className="absolute left-0 top-10 flex w-[300px] flex-col gap-0.5 rounded-lg p-2"
                style={{
                  background: C.panelHead,
                  border: `1px solid rgba(255,255,255,0.1)`,
                  boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
                }}
              >
                <Link
                  href="/product"
                  className="flex items-start gap-3 rounded-md p-3 hover:bg-[rgba(255,255,255,0.05)]"
                >
                  <span
                    className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ background: C.accent }}
                  />
                  <span className="flex flex-col gap-[3px]">
                    <span className="text-sm font-semibold" style={{ color: C.ink }}>
                      AgentX
                    </span>
                    <span className="text-[12.5px] leading-[1.45]" style={{ color: C.mute }}>
                      MCP-native backend platform. Live.
                    </span>
                  </span>
                </Link>
                <Link
                  href="/hostile-agent"
                  className="flex items-start gap-3 rounded-md p-3 hover:bg-[rgba(255,255,255,0.05)]"
                >
                  <span
                    className="mt-1.5 box-border h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ border: `1px solid ${C.faint}` }}
                  />
                  <span className="flex flex-col gap-[3px]">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-semibold" style={{ color: C.ink }}>
                        Hostile Agent
                      </span>
                      <span
                        className="rounded-[3px] px-1.5 py-0.5 font-mono text-[9.5px] tracking-[0.08em]"
                        style={{ color: C.mute, border: `1px solid rgba(255,255,255,0.14)` }}
                      >
                        SOON
                      </span>
                    </span>
                    <span className="text-[12.5px] leading-[1.45]" style={{ color: C.mute }}>
                      Autonomous security testing for your own systems.
                    </span>
                  </span>
                </Link>
              </div>
            )}
          </div>
          {items.map(([seg, label]) => (
            <Link
              key={seg}
              href={`/${seg}`}
              className="rounded-[4px] px-3 py-2 hover:bg-[rgba(255,255,255,0.05)]"
              style={{ color: linkColor(seg) }}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Link href="/developers" className="px-3.5 py-2 font-mono text-xs" style={{ color: C.mute }}>
          docs
        </Link>
        <Link
          href="/pricing"
          className="mkt-cta whitespace-nowrap rounded-[4px] px-[18px] py-2.5 font-mono text-xs font-semibold tracking-[0.02em]"
        >
          Become a beta tester
        </Link>
      </div>
    </nav>
  );
}
