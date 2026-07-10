import type { ReactNode } from "react";

/**
 * Shared presentational helpers for the admin control-plane surfaces (studio
 * fleet + project overview). Server-safe (no client hooks). The visual language:
 * brand color = identity only, green = live/system status only, mono for every
 * machine-produced value (ids, endpoints, counts, timestamps).
 */

export type ConnStatus = "connected" | "error" | "absent";

/** Relative "last write" recency — the fleet's pulse. */
export function ago(iso: string | null): string {
  if (!iso) return "no writes yet";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/** True when the last write is within the active window (drives the pulse). */
export function isActive(iso: string | null): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < 1000 * 60 * 60 * 24 * 3; // 3 days
}

export function sinceMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

const ACCENT = "var(--color-accent)";
const WARN = "var(--color-warn)";
const FAINT = "var(--color-line-strong)";

/** A status dot; `live` adds the one allowed looping pulse. */
export function Dot({ status, live = false }: { status: ConnStatus | "live"; live?: boolean }) {
  const color =
    status === "connected" || status === "live" ? ACCENT : status === "error" ? "var(--color-err)" : FAINT;
  return (
    <span
      className="inline-block h-[7px] w-[7px] rounded-full"
      style={{
        background: status === "absent" ? "transparent" : color,
        border: status === "absent" ? `1px solid ${FAINT}` : undefined,
        animation: live ? "pulse-dot 2.4s ease-in-out infinite" : undefined,
      }}
    />
  );
}

/** Connector health — three named channels an operator actually recognizes. */
export function ConnectorHealth({
  connectors,
}: {
  connectors: { type: string; status: string }[];
}) {
  const byType = new Map(connectors.map((c) => [c.type, c.status]));
  const channel = (type: string, label: string): ReactNode => {
    const raw = byType.get(type);
    const status: ConnStatus = !raw ? "absent" : raw === "connected" ? "connected" : "error";
    return (
      <span
        key={type}
        className="inline-flex items-center gap-1.5 font-mono text-[10.5px]"
        style={{ color: status === "absent" ? FAINT : "var(--color-ink-mute)" }}
        title={`${label}: ${status === "absent" ? "not connected" : status}`}
      >
        <Dot status={status} />
        {label}
      </span>
    );
  };
  return (
    <span className="inline-flex items-center gap-3">
      {channel("clerk", "auth")}
      {channel("resend", "email")}
      {channel("stripe", "pay")}
    </span>
  );
}

/** A brand identity tile — the client's color as a fill, initial or logo on it. */
export function BrandTile({
  brand,
  brandInk,
  initial,
  logoUrl,
  size = 40,
}: {
  brand: string;
  brandInk: string;
  initial: string;
  logoUrl?: string | null;
  size?: number;
}) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        className="shrink-0 rounded-[9px] object-cover"
        style={{ width: size, height: size, boxShadow: `inset 0 0 0 1px var(--color-line)` }}
      />
    );
  }
  return (
    <span
      className="display grid shrink-0 place-items-center rounded-[9px] font-semibold"
      style={{
        width: size,
        height: size,
        background: brand,
        color: brandInk,
        fontSize: size * 0.4,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, white 14%, transparent)`,
      }}
    >
      {initial}
    </span>
  );
}

/** A count with a mono label — the operator's scan units. */
export function Metric({ value, label }: { value: ReactNode; label: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-mono text-[15px] tabular-nums text-[--color-ink]">{value}</span>
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[--color-ink-mute]">
        {label}
      </span>
    </span>
  );
}
