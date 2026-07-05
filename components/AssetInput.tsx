"use client";

import { useState } from "react";

/**
 * Asset upload with preview. Uploads to the Clerk-authed admin upload route,
 * stores the returned asset id in a hidden input so it submits with the form.
 */
export function AssetInput({
  projectId,
  name,
  initialId,
}: {
  projectId: string;
  name: string;
  initialId: string;
}) {
  const [assetId, setAssetId] = useState(initialId);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("projectId", projectId);
    fd.append("file", file);
    const res = await fetch("/api/admin/upload", { method: "POST", body: fd });
    setBusy(false);
    if (res.ok) {
      const json = await res.json();
      setAssetId(json.id);
      setUrl(json.url);
    }
  }

  return (
    <div>
      <input type="hidden" name={name} value={assetId} />
      <input
        type="file"
        onChange={onFile}
        disabled={busy}
        className="block text-sm text-[--color-ink-soft] file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-strong hover:file:opacity-80"
      />
      {busy && <p className="mt-1 text-sm text-[--color-ink-mute]">Uploading…</p>}
      {url && url.match(/\.(png|jpe?g|gif|webp|svg)$/i) && (
        <img src={url} alt="" className="mt-2 max-w-48 rounded-lg border border-[--color-line]" />
      )}
      {assetId && !url && <p className="mt-1 text-xs text-[--color-ink-mute]">Current asset: {assetId}</p>}
    </div>
  );
}
