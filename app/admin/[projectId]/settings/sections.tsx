"use client";

import { useState } from "react";
import { Check, Copy, Eye, EyeOff, Trash2 } from "lucide-react";
import { McpSnippet } from "@/components/McpSnippet";
import {
  updateBranding,
  mintToken,
  revokeToken,
  updateWebhook,
  addMember,
  removeMember,
  saveConnector,
  disconnectConnector,
  testConnector,
  rotateConnectorSecretAction,
  provisionStripeWebhook,
  connectNeonAction,
} from "./actions";

const inputClass = "field-input";
const buttonClass = "btn btn-primary disabled:opacity-60";

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="alert-error mt-2 rounded-lg px-3 py-2 text-sm">{error}</p>;
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
      className="card max-w-md p-5"
    >
      <label className="mb-1 block text-sm font-medium">Display name</label>
      <input name="displayName" defaultValue={initial.displayName} className={`${inputClass} mb-3`} />

      <label className="mb-1 block text-sm font-medium">Brand color</label>
      <input
        type="color"
        name="primaryColor"
        defaultValue={initial.primaryColor}
        className="mb-3 h-9 w-14 cursor-pointer rounded border border-line"
      />

      <label className="mb-1 block text-sm font-medium">Logo</label>
      <input type="hidden" name="logoUrl" value={logoUrl} />
      <div className="mb-3 flex items-center gap-3">
        {logoUrl && <img src={logoUrl} alt="" className="h-9 w-9 rounded-lg border border-line object-cover" />}
        <input type="file" accept="image/*" onChange={onLogoFile} disabled={uploading} className="text-sm text-ink-soft" />
      </div>


      <button type="submit" className={buttonClass}>
        {saved ? "Saved" : "Save branding"}
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

export function SecretReveal({ secret }: { secret: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!secret) return <p className="card max-w-md p-4 text-sm text-ink-mute">No secret generated yet.</p>;

  return (
    <div className="card flex max-w-md items-center gap-2 p-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs">
        {shown ? secret : "•".repeat(40)}
      </code>
      <button
        type="button"
        aria-label={shown ? "Hide secret" : "Show secret"}
        onClick={() => setShown(!shown)}
        className="rounded p-1.5 text-ink-mute hover:bg-paper"
      >
        {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(secret);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:bg-paper"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function lastUsedLabel(iso: string | null): string {
  if (!iso) return "never used";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `used ${mins}m ago`;
  if (mins < 60 * 24) return `used ${Math.round(mins / 60)}h ago`;
  return `used ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export function TokensSection({
  projectId,
  tokens,
}: {
  projectId: string;
  tokens: {
    id: string;
    label: string | null;
    scope: string;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<"mcp" | "delivery">("mcp");

  return (
    <div className="card max-w-md p-5">
      {tokens.length === 0 ? (
        <p className="mb-3 text-sm text-ink-mute">No active tokens.</p>
      ) : (
        <ul className="mb-3 divide-y divide-line">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="font-mono text-xs text-ink-mute">agx_••••••••</span>
              <span className="truncate">{t.label ?? "untitled"}</span>
              <span className={`chip ${t.scope === "mcp" ? "chip-brand" : "chip-mute"}`}>{t.scope}</span>
              <span className="ml-auto whitespace-nowrap text-xs text-ink-mute" title="≤5 min granularity">
                {lastUsedLabel(t.lastUsedAt)}
              </span>
              <button
                type="button"
                aria-label="Revoke token"
                onClick={async () => {
                  const res = await revokeToken(projectId, t.id);
                  setError(res.error ?? null);
                }}
                className="rounded p-1 text-ink-mute transition-colors hover:text-err"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {revealed && (
        <div className="mb-3">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-sm">{revealed}</code>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(revealed);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:bg-paper"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="alert-warn my-2 rounded-lg px-3 py-2 text-sm">
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
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "mcp" | "delivery")}
          className={`${inputClass} w-32 shrink-0`}
          aria-label="Token scope"
        >
          <option value="mcp">mcp (full)</option>
          <option value="delivery">delivery</option>
        </select>
        <button
          type="button"
          onClick={async () => {
            const res = await mintToken(projectId, label, scope);
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
      <p className="mt-2 text-xs text-ink-mute">
        Give the site a delivery-scoped token (public read/write only) — never the
        mcp token, which can change schemas.
      </p>
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
      className="card max-w-md p-5"
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

export interface ConnectorCardProps {
  projectId: string;
  type: "clerk" | "resend" | "stripe";
  label: string;
  configFields: { key: string; label: string; placeholder: string }[];
  secretLabel: string | null;
  /** Named secret slots beyond the primary (e.g. stripe webhookSigning). */
  extraSecrets?: { slot: string; label: string }[];
  /** Slots that already hold a stored secret (names only — never values). */
  storedSlots?: string[];
  connected: boolean;
  hasSecret: boolean;
  status: string;
  config: Record<string, string>;
}

export function ConnectorCard(p: ConnectorCardProps) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [newKey, setNewKey] = useState("");

  return (
    <form
      action={async (fd) => {
        setBusy(true);
        setNote(null);
        const res = await saveConnector(p.projectId, p.type, fd);
        setBusy(false);
        setError(res.error ?? null);
        if (!res.error) setNote("Saved");
      }}
      className="card max-w-md p-5"
    >
      <div className="mb-3 flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full"
          style={{
            background: !p.connected
              ? "var(--color-line-strong)"
              : p.status === "connected"
                ? "var(--color-ok)"
                : "var(--color-err)",
          }}
        />
        <p className="text-sm font-medium">{p.label}</p>
        {p.connected && (
          <span className="text-xs text-ink-mute">
            {p.status === "connected" ? "connected" : "error"}
          </span>
        )}
      </div>

      {p.configFields.map((f) => (
        <div key={f.key} className="mb-3">
          <label className="mb-1 block text-xs text-ink-mute">{f.label}</label>
          <input name={f.key} defaultValue={p.config[f.key] ?? ""} placeholder={f.placeholder} className={inputClass} />
        </div>
      ))}
      {p.secretLabel && (
        <div className="mb-3">
          <label className="mb-1 block text-xs text-ink-mute">
            {p.secretLabel}
            {p.hasSecret ? " (stored — leave blank to keep)" : ""}
          </label>
          <input name="secret" type="password" placeholder={p.hasSecret ? "••••••••" : ""} className={inputClass} />
        </div>
      )}
      {(p.extraSecrets ?? []).map((extra) => {
        const stored = (p.storedSlots ?? []).includes(extra.slot);
        return (
          <div key={extra.slot} className="mb-3">
            <label className="mb-1 block text-xs text-ink-mute">
              {extra.label}
              {stored ? " (stored — leave blank to keep)" : ""}
            </label>
            <input
              name={`secret:${extra.slot}`}
              type="password"
              placeholder={stored ? "••••••••" : ""}
              className={inputClass}
            />
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className={buttonClass}>
          {p.connected ? "Save" : "Connect"}
        </button>
        {p.connected && (
          <>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                setBusy(true);
                setNote(null);
                const res = await testConnector(p.projectId, p.type);
                setBusy(false);
                setError(res.error ?? null);
                if (!res.error) setNote(res.ok ? `OK — ${res.detail}` : `Failed — ${res.detail}`);
              }}
            >
              Test
            </button>
            {p.hasSecret && p.secretLabel && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setRotating((v) => !v);
                  setNote(null);
                  setError(null);
                }}
              >
                Rotate key
              </button>
            )}
            {p.type === "stripe" && p.hasSecret && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setNote(null);
                  setError(null);
                  const res = await provisionStripeWebhook(p.projectId);
                  setBusy(false);
                  setError(res.error ?? null);
                  if (!res.error) setNote(res.ok ? `OK — ${res.detail}` : `Failed — ${res.detail}`);
                }}
                title="Register this project's webhook endpoint with Stripe and store the signing secret automatically"
              >
                {p.config.webhookEndpointId ? "Re-provision webhook" : "Provision webhook"}
              </button>
            )}
            <button
              type="button"
              className="btn btn-danger-ghost"
              onClick={async () => {
                const res = await disconnectConnector(p.projectId, p.type);
                setError(res.error ?? null);
              }}
            >
              Disconnect
            </button>
          </>
        )}
        {note && <span className="text-xs text-ink-mute">{note}</span>}
      </div>
      {rotating && (
        <div className="mt-3 rounded-lg border border-line bg-paper p-3">
          <label className="mb-1 block text-xs text-ink-mute">
            New {p.secretLabel?.toLowerCase()} — validated against the provider before the old
            one is replaced
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="re_…"
              className={inputClass}
            />
            <button
              type="button"
              disabled={busy || !newKey.trim()}
              className={`${buttonClass} shrink-0`}
              onClick={async () => {
                setBusy(true);
                const res = await rotateConnectorSecretAction(p.projectId, p.type, newKey);
                setBusy(false);
                setError(res.error ?? (res.ok ? null : res.detail));
                if (res.ok) {
                  setNote(res.detail);
                  setRotating(false);
                  setNewKey("");
                }
              }}
            >
              {busy ? "Validating…" : "Rotate"}
            </button>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
    </form>
  );
}

/**
 * The data-plane connector (A2). Deliberately its own card, not a
 * CONNECTOR_SPECS entry: Connect validates the database and installs the
 * schema BEFORE anything is stored, which the generic save flow can't do.
 */
export function NeonConnectorCard(p: {
  projectId: string;
  connected: boolean;
  status: string;
  host: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      action={async (fd) => {
        setBusy(true);
        setNote(null);
        setError(null);
        const res = await connectNeonAction(p.projectId, fd);
        setBusy(false);
        setError(res.error ?? null);
        if (!res.error) setNote(res.detail ?? "Connected");
      }}
      className="card max-w-md p-5"
    >
      <div className="mb-3 flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full"
          style={{
            background: !p.connected
              ? "var(--color-line-strong)"
              : p.status === "connected"
                ? "var(--color-ok)"
                : "var(--color-err)",
          }}
        />
        <p className="text-sm font-medium">Neon Postgres (project database)</p>
        {p.connected && (
          <span className="text-xs text-ink-mute">
            {p.status === "connected" ? `connected — ${p.host ?? "database"}` : "error"}
          </span>
        )}
      </div>

      <p className="mb-3 text-xs text-ink-mute">
        Give this project its own Postgres database — all content (entries, assets
        metadata, history) lives there instead of the shared plane. Connect
        validates the database, installs the schema, and only then stores the
        connection string (encrypted). Attach it <em>before</em> creating content:
        existing content is not migrated.
      </p>

      <div className="mb-3">
        <label className="mb-1 block text-xs text-ink-mute">
          Connection string{p.connected ? " (stored — paste again to re-install/heal)" : ""}
        </label>
        <input
          name="connectionString"
          type="password"
          placeholder={p.connected ? "••••••••" : "postgres://user:pass@host/dbname"}
          className={inputClass}
        />
      </div>

      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? "Validating…" : p.connected ? "Reconnect" : "Connect"}
        </button>
        {p.connected && (
          <>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setNote(null);
                const res = await testConnector(p.projectId, "neon");
                setBusy(false);
                setError(res.error ?? null);
                if (!res.error) setNote(res.ok ? `OK — ${res.detail}` : `Failed — ${res.detail}`);
              }}
            >
              Test
            </button>
            <button
              type="button"
              className="btn btn-danger-ghost"
              disabled={busy}
              onClick={async () => {
                if (
                  !window.confirm(
                    "Disconnect this database? Your database and its data are NEVER deleted, but the project's content becomes unreachable through the platform until you reconnect it.",
                  )
                ) {
                  return;
                }
                const res = await disconnectConnector(p.projectId, "neon");
                setError(res.error ?? null);
                if (!res.error) setNote("Disconnected — your database was not touched");
              }}
            >
              Disconnect
            </button>
          </>
        )}
        {note && <span className="text-xs text-ink-mute">{note}</span>}
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
    <div className="card max-w-md p-5">
      {members.length === 0 ? (
        <p className="mb-3 text-sm text-ink-mute">No members yet — only platform operators can open this project.</p>
      ) : (
        <ul className="mb-3 divide-y divide-line">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="truncate">{m.email}</span>
              <span className="rounded-full bg-paper px-2 py-0.5 text-xs text-ink-soft">{m.role}</span>
              <button
                type="button"
                aria-label="Remove member"
                onClick={async () => {
                  const res = await removeMember(projectId, m.id);
                  setError(res.error ?? null);
                }}
                className="ml-auto rounded p-1 text-ink-mute transition-colors hover:text-err"
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
