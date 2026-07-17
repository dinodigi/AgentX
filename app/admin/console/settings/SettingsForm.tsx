"use client";

import { useState } from "react";
import { savePlatformSettingsAction } from "../actions";

/**
 * Platform Settings (operator console): caps per tier + metered billing
 * rates, edited here instead of env vars / code constants. Byte fields are
 * entered in MB for humans; stored as bytes.
 */
type Caps = { entries: number; collections: number; assetBytes: number; dataBytes: number };

const MB = 1024 * 1024;

export function SettingsForm({
  initial,
}: {
  initial: {
    sandbox: Caps;
    paid: Caps;
    rates: { computeCentsPerCuHour: number; storageCentsPerGbMonth: number } | null;
    ratesFromEnv: boolean;
  };
}) {
  const [sandbox, setSandbox] = useState(initial.sandbox);
  const [paid, setPaid] = useState(initial.paid);
  const [meteringOn, setMeteringOn] = useState(initial.rates !== null);
  const [compute, setCompute] = useState(initial.rates?.computeCentsPerCuHour ?? 35);
  const [storage, setStorage] = useState(initial.rates?.storageCentsPerGbMonth ?? 50);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await savePlatformSettingsAction({
      capsSandbox: sandbox,
      capsPaid: paid,
      meteredRates: meteringOn
        ? { computeCentsPerCuHour: compute, storageCentsPerGbMonth: storage }
        : null,
    });
    setBusy(false);
    setMsg(res.error ?? "Saved — takes effect immediately.");
  }

  const capRow = (label: string, caps: Caps, set: (c: Caps) => void) => (
    <div className="rounded-lg border border-line p-4">
      <p className="mb-3 text-sm font-medium">{label}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <NumField label="Entries" value={caps.entries} onChange={(v) => set({ ...caps, entries: v })} />
        <NumField label="Collections" value={caps.collections} onChange={(v) => set({ ...caps, collections: v })} />
        <NumField
          label="Media (MB)"
          value={Math.round(caps.assetBytes / MB)}
          onChange={(v) => set({ ...caps, assetBytes: v * MB })}
        />
        <NumField
          label="Content (MB)"
          value={Math.round(caps.dataBytes / MB)}
          onChange={(v) => set({ ...caps, dataBytes: v * MB })}
        />
      </div>
    </div>
  );

  return (
    <div className="max-w-2xl space-y-6">
      <section>
        <h2 className="section-label mb-1">Plan caps</h2>
        <p className="mb-3 text-sm text-ink-mute">
          Abuse ceilings enforced at write time (E_CAP_REACHED). The safety floor under the meter —
          not the biller.
        </p>
        <div className="space-y-3">
          {capRow("Sandbox (free)", sandbox, setSandbox)}
          {capRow("Paid (BYO / managed)", paid, setPaid)}
        </div>
      </section>

      <section>
        <h2 className="section-label mb-1">Metered billing</h2>
        <p className="mb-3 text-sm text-ink-mute">
          Bills managed projects&apos; actual Neon usage as metered Stripe items on top of the flat
          plan. Off = flat pricing only. Set rates above your Neon cost.
          {initial.ratesFromEnv && " (Currently active via the METERED_RATES env — saving here takes precedence.)"}
        </p>
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={meteringOn}
            onChange={(e) => setMeteringOn(e.target.checked)}
            className="h-4 w-4 accent-[var(--brand)]"
          />
          Enable usage metering
        </label>
        {meteringOn && (
          <div className="grid max-w-md grid-cols-2 gap-3">
            <NumField label="¢ per CU-hour (compute)" value={compute} onChange={setCompute} />
            <NumField label="¢ per GB-month (storage)" value={storage} onChange={setStorage} />
          </div>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={busy} className="btn btn-primary disabled:opacity-60">
          {busy ? "Saving…" : "Save settings"}
        </button>
        {msg && <span className={msg.startsWith("Saved") ? "text-sm text-ok" : "text-sm text-err"}>{msg}</span>}
      </div>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-ink-soft">{label}</span>
      <input
        type="number"
        min={0}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className="field-input"
      />
    </label>
  );
}
