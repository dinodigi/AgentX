"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";

/** Upload button for the Media page — posts to the admin upload route, then refreshes. */
export function AssetUploader({ projectId }: { projectId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onPick(file: File) {
    setPending(true);
    setError(null);
    const fd = new FormData();
    fd.append("projectId", projectId);
    fd.append("file", file);
    const res = await fetch("/api/admin/upload", { method: "POST", body: fd });
    setPending(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "upload failed");
      return;
    }
    router.refresh();
  }

  return (
    <div className="ml-auto flex items-center gap-3">
      {error && <p className="text-xs text-err">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onPick(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
        className="btn btn-primary disabled:opacity-60"
      >
        <Upload className="h-4 w-4" />
        {pending ? "Uploading…" : "Upload"}
      </button>
    </div>
  );
}
