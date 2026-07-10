"use client";

import { useState } from "react";
import { FileText, Trash2 } from "lucide-react";

/**
 * One tile in the Media grid: preview, metadata, two-click delete. A blocked
 * delete (entries still reference the file) surfaces the server's hint inline
 * instead of vanishing.
 */
export function AssetCard({
  filename,
  contentType,
  size,
  url,
  action,
}: {
  filename: string;
  contentType: string;
  size: number;
  url: string;
  action: () => Promise<{ error?: string } | void>;
}) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isImage = contentType.startsWith("image/");

  return (
    <div className="card overflow-hidden">
      <a href={url} target="_blank" rel="noreferrer" className="block">
        {isImage ? (
          <img src={url} alt={filename} className="h-32 w-full object-cover" />
        ) : (
          <div className="flex h-32 w-full items-center justify-center bg-[--color-paper]">
            <FileText className="h-8 w-8 text-[--color-ink-mute]" />
          </div>
        )}
      </a>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={filename}>
            {filename}
          </p>
          <p className="text-[11px] text-[--color-ink-mute]">{formatBytes(size)}</p>
        </div>
        <button
          type="button"
          disabled={pending}
          title={armed ? "Click again to delete permanently" : "Delete"}
          onClick={async () => {
            if (!armed) {
              setArmed(true);
              setError(null);
              setTimeout(() => setArmed(false), 3000);
              return;
            }
            setPending(true);
            const res = await action();
            setPending(false);
            setArmed(false);
            if (res && "error" in res && res.error) setError(res.error);
          }}
          className={`shrink-0 rounded p-1.5 transition-colors ${
            armed
              ? "bg-[--color-err] text-white"
              : "text-[--color-ink-mute] hover:text-[--color-err]"
          }`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {error && (
        <p className="alert-error border-t px-3 py-2 text-[11px] leading-snug">
          {error}
        </p>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
