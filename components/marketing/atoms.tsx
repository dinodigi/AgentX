import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Marketing design atoms (rebrand direction). Marketing is a fixed dark
 * register, so these use the direction's literal palette rather than the
 * theme-flipping --color-* tokens the admin uses. Accent green = #43DE83.
 */

export const C = {
  page: "#0A0B0D",
  deep: "#08090B",
  panel: "#0D0F12",
  panelHead: "#101215",
  hover: "#0E1013",
  accent: "#43DE83",
  accentHi: "#5BEA9A",
  ink: "#E7EAE8",
  mute: "#9BA3A0",
  faint: "#5C6360",
  fainter: "#464C49",
  err: "#FF7B72",
  warn: "#FFC66D",
  line: "rgba(255,255,255,0.08)",
  lineHi: "rgba(255,255,255,0.15)",
} as const;

/** Mono meta label (the "if the machine produced it, it's mono" voice). */
export function Eyebrow({
  children,
  tone = "accent",
}: {
  children: ReactNode;
  tone?: "accent" | "mute";
}) {
  return (
    <span
      className="font-mono text-xs tracking-[0.14em]"
      style={{ color: tone === "accent" ? C.accent : C.mute }}
    >
      {children}
    </span>
  );
}

/** LIVE / SOON / COMING SOON status pill. */
export function StatusBadge({ kind }: { kind: "live" | "soon" | "coming-soon" }) {
  const live = kind === "live";
  const label = kind === "live" ? "LIVE" : kind === "soon" ? "SOON" : "COMING SOON";
  return (
    <span
      className="font-mono text-[10px] tracking-[0.08em] rounded-[3px] px-2 py-[3px]"
      style={{
        color: live ? C.accent : C.mute,
        border: `1px solid ${live ? "rgba(67,222,131,0.4)" : "rgba(255,255,255,0.18)"}`,
      }}
    >
      {label}
    </span>
  );
}

/** Primary (green fill) or ghost CTA. */
export function CTA({
  href,
  children,
  variant = "primary",
  size = "md",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "ghost";
  size?: "md" | "lg";
}) {
  const pad = size === "lg" ? "px-8 py-4 text-sm" : "px-6 py-[13px] text-[13px]";
  const cls = variant === "primary" ? "mkt-cta font-semibold" : "mkt-ghost";
  return (
    <Link href={href} className={`${cls} font-mono rounded-[4px] whitespace-nowrap ${pad}`}>
      {children}
    </Link>
  );
}

/** Section index heading: "/ 01  Title". */
export function SectionHead({
  index,
  title,
  right,
}: {
  index: string;
  title: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-14 flex flex-wrap items-baseline justify-between gap-4">
      <div className="flex items-baseline gap-5">
        <span className="font-mono text-xs" style={{ color: C.accent }}>
          {index}
        </span>
        <h2 className="m-0 text-[clamp(26px,3.4vw,34px)] font-bold tracking-[-0.02em]">{title}</h2>
      </div>
      {right}
    </div>
  );
}

/** A single terminal-transcript line: "pre  text". */
export function TxLine({
  pre,
  children,
  color = C.mute,
}: {
  pre: string;
  children: ReactNode;
  color?: string;
}) {
  return (
    <div>
      <span style={{ color: C.faint }}>{pre}</span> <span style={{ color }}>{children}</span>
    </div>
  );
}
