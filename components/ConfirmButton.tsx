"use client";

import { useState } from "react";

/**
 * Small action button with optional two-click arming (for destructive actions)
 * and inline error surfacing. Server action returns { error } or void.
 */
export function ConfirmButton({
  action,
  label,
  pendingLabel,
  confirmLabel,
  danger = false,
  arm = false,
}: {
  action: () => Promise<{ error?: string } | void>;
  label: string;
  pendingLabel: string;
  confirmLabel?: string;
  danger?: boolean;
  arm?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (arm && !armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 3000);
      return;
    }
    setPending(true);
    setError(null);
    const res = await action();
    setPending(false);
    setArmed(false);
    if (res && "error" in res && res.error) setError(res.error);
  };

  const base =
    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-50";
  const tone = danger
    ? armed
      ? "border-[--color-err] bg-[--color-err] text-white"
      : "border-[--color-line] text-[--color-ink-mute] hover:border-[--color-err] hover:text-[--color-err]"
    : "border-[--color-line] text-[--color-ink-mute] hover:border-[--color-line-strong] hover:text-[--color-ink-soft]";

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" disabled={pending} onClick={run} className={`${base} ${tone}`}>
        {pending ? pendingLabel : armed && confirmLabel ? confirmLabel : label}
      </button>
      {error && <span className="text-[11px] text-[--color-err]">{error}</span>}
    </span>
  );
}
