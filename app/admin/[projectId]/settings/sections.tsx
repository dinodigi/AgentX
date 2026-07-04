"use client";

import { useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import { McpSnippet } from "@/components/McpSnippet";
import {
  updateBranding,
  mintToken,
  revokeToken,
  updateWebhook,
  addMember,
  removeMember,
} from "./actions";

const inputClass =
  "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-soft";
const buttonClass =
  "rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-60";

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
}

export function BrandingForm({
  projectId,
  initial,
}: {
  projectId: string;
  initial: { displayName: string; primaryColor: string; logoUrl: string };
}) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl);
  const [uploading, setUploading] = useState(false);

  async function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("projectId", projectId);
    fd.append("file", file);
    const res = await fetch("/api/admin/upload", { method: "POST", body: fd });
    setUploading(false);
    if (res.ok) setLogoUrl((await res.json()).url);
  }

  return (
    <form
      action={async (fd) => {
        setSaved(false);
        const res = await updateBranding(projectId, fd);
        setError(res.error ?? null);
        if (!res.error) setSaved(true);
      }}
      className="max-w-md rounded-xl border border-gray-200 p-4"
    >
      <label className="mb-1 block text-sm font-medium">Display name</label>
      <input name="displayName" defaultValue={initial.displayName} className={`${inputClass} mb-3`} />

      <label className="mb-1 block text-sm font-medium">Brand color</label>
      <input
        type="color"
        name="primaryColor"
        defaultValue={initial.primaryColor}
        className="mb-3 h-9 w-14 cursor-pointer rounded border border-gray-200"
      />

      <label className="mb-1 block text-sm font-medium">Logo</label>
      <input type="hidden" name="logoUrl" value={logoUrl} />
      <div className="mb-3 flex items-center gap-3">
        {logoUrl && <img src={logoUrl} alt="" className="h-9 w-9 rounded-lg border border-gray-200 object-cover" />}
        <input type="file" accept="image/*" onChange={onLogoFile} disabled={uploading} className="text-sm text-gray-600" />
      </div>

      <button type="submit" className={buttonClass}>
        {saved ? "Saved" : "Save branding"}
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

export function TokensSection({
  projectId,
  tokens,
}: {
  projectId: string;
  tokens: { id: string; label: string | null; createdAt: string }[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [label, setLabel] = useState("");

  return (
    <div className="max-w-md rounded-xl border border-gray-200 p-4">
      {tokens.length === 0 ? (
        <p className="mb-3 text-sm text-gray-400">No active tokens.</p>
      ) : (
        <ul className="mb-3 divide-y divide-gray-100">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="font-mono text-xs text-gray-400">agx_••••••••</span>
              <span className="truncate">{t.label ?? "untitled"}</span>
              <span className="ml-auto text-xs text-gray-400">
                {new Date(t.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
              <button
                type="button"
                aria-label="Revoke token"
                onClick={async () => {
                  const res = await revokeToken(projectId, t.id);
                  setError(res.error ?? null);
                }}
                className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {revealed && (
        <div className="mb-3">
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-sm">{revealed}</code>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(revealed);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs hover:bg-gray-100"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="my-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Shown once — store it now.
          </p>
          <McpSnippet token={revealed} />
        </div>
      )}

      <div className="flex gap-2">
        <input
          placeholder="Token label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className={inputClass}
        />
        <button
          type="button"
          onClick={async () => {
            const res = await mintToken(projectId, label);
            setError(res.error ?? null);
            if (res.token) {
              setRevealed(res.token);
              setLabel("");
            }
          }}
          className={`${buttonClass} shrink-0`}
        >
          Mint token
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

export function WebhookForm({
  projectId,
  collectionName,
  displayName,
  initialUrl,
}: {
  projectId: string;
  collectionName: string;
  displayName: string;
  initialUrl: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <form
      action={async (fd) => {
        setSaved(false);
        const res = await updateWebhook(projectId, collectionName, fd);
        setError(res.error ?? null);
        if (!res.error) setSaved(true);
      }}
      className="max-w-md rounded-xl border border-gray-200 p-4"
    >
      <p className="mb-2 text-sm font-medium">{displayName}</p>
      <div className="flex gap-2">
        <input
          name="webhookUrl"
          defaultValue={initialUrl}
          placeholder="https://hooks.example.com/lead"
          className={inputClass}
        />
        <button type="submit" className={`${buttonClass} shrink-0`}>
          {saved ? "Saved" : "Save"}
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

export function MembersSection({
  projectId,
  members,
}: {
  projectId: string;
  members: { id: string; email: string; role: string }[];
}) {
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="max-w-md rounded-xl border border-gray-200 p-4">
      {members.length === 0 ? (
        <p className="mb-3 text-sm text-gray-400">No members yet — only platform operators can open this project.</p>
      ) : (
        <ul className="mb-3 divide-y divide-gray-100">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="truncate">{m.email}</span>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{m.role}</span>
              <button
                type="button"
                aria-label="Remove member"
                onClick={async () => {
                  const res = await removeMember(projectId, m.id);
                  setError(res.error ?? null);
                }}
                className="ml-auto rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        action={async (fd) => {
          const res = await addMember(projectId, fd);
          setError(res.error ?? null);
        }}
        className="flex gap-2"
      >
        <input name="email" placeholder="client@company.com" className={inputClass} />
        <select name="role" defaultValue="client" className={`${inputClass} w-28 shrink-0`}>
          <option value="client">client</option>
          <option value="operator">operator</option>
        </select>
        <button type="submit" className={`${buttonClass} shrink-0`}>
          Add
        </button>
      </form>
      <ErrorLine error={error} />
    </div>
  );
}
