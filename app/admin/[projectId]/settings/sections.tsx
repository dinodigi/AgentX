import type { FormConnectorType } from "@/lib/connectors";
"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff, Search, Trash2, Type } from "lucide-react";
import { McpSnippet } from "@/components/McpSnippet";
import { PROJECT_ICON_NAMES, PROJECT_ICONS, projectIcon } from "@/components/admin/project-icons";
import { brandInk } from "@/lib/brand";
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
  provisionManagedAction,
  deprovisionManagedAction,
  connectR2Action,
  provisionManagedBucketAction,
  deprovisionManagedBucketAction,
  openBillingPortalAction,
  togglePluginAction,
} from "./actions";

const inputClass = "field-input";
const buttonClass = "btn btn-primary disabled:opacity-60";

/** Opens the Stripe Billing Portal for the current subscriber (B3). */
export function ManageBillingButton({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className="btn btn-ink disabled:opacity-60"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await openBillingPortalAction(projectId);
          setBusy(false);
          if (res.error) setError(res.error);
          else if (res.url) window.location.href = res.url;
        }}
      >
        {busy ? "Opening…" : "Manage subscription"}
      </button>
      {error && <span className="text-[11px] text-err">{error}</span>}
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="alert-error mt-2 rounded-lg px-3 py-2 text-sm">{error}</p>;
}

export function BrandingForm({
  projectId,
  initial,
}: {
  projectId: string;
  initial: { displayName: string; primaryColor: string; icon: string };
}) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Controlled so the preview tile updates live as you edit.
  const [name, setName] = useState(initial.displayName);
  const [color, setColor] = useState(initial.primaryColor || "#4f46e5");
  const [icon, setIcon] = useState(initial.icon);
  const [q, setQ] = useState("");

  const ink = brandInk(color);
  const PreviewIcon = projectIcon(icon);
  const matches = useMemo(
    () => (q ? PROJECT_ICON_NAMES.filter((n) => n.includes(q.toLowerCase())) : PROJECT_ICON_NAMES),
    [q],
  );

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
      {/* Live preview — the tile as it appears across the admin. */}
      <div className="mb-5 flex items-center gap-3 rounded-lg border border-line bg-paper p-3">
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] font-semibold"
          style={{ background: color, color: ink, boxShadow: "inset 0 0 0 1px color-mix(in srgb, white 14%, transparent)" }}
        >
          {PreviewIcon ? <PreviewIcon className="h-5 w-5" strokeWidth={2} /> : name.charAt(0).toUpperCase() || "P"}
        </span>
        <div className="min-w-0">
          <p className="m-0 truncate text-sm font-semibold text-ink">{name || "Project name"}</p>
          <p className="m-0 font-mono text-[11px] text-line-strong">how it looks everywhere</p>
        </div>
      </div>

      <label className="mb-1 block text-sm font-medium">Display name</label>
      <input name="displayName" value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mb-3`} />

      <label className="mb-1 block text-sm font-medium">Brand color</label>
      <input
        type="color"
        name="primaryColor"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="mb-4 h-9 w-14 cursor-pointer rounded border border-line"
      />

      <label className="mb-1 block text-sm font-medium">Icon</label>
      <input type="hidden" name="icon" value={icon} />
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-line-strong" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search icons…"
          className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-line-strong"
        />
      </div>
      <div className="mb-4 grid max-h-[188px] grid-cols-8 gap-1 overflow-y-auto rounded-lg border border-line p-2">
        {/* Monogram (no icon) option. */}
        <IconCell selected={!icon} onClick={() => setIcon("")} label="Letter monogram">
          <Type className="h-4 w-4" />
        </IconCell>
        {matches.map((n) => {
          const Ico = PROJECT_ICONS[n];
          return (
            <IconCell key={n} selected={icon === n} onClick={() => setIcon(n)} label={n}>
              <Ico className="h-4 w-4" />
            </IconCell>
          );
        })}
        {matches.length === 0 && (
          <p className="col-span-8 px-1 py-3 text-center font-mono text-[11px] text-line-strong">no icons match</p>
        )}
      </div>

      <button type="submit" className={buttonClass}>
        {saved ? "Saved" : "Save branding"}
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

function IconCell({
  selected,
  onClick,
  label,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid aspect-square place-items-center rounded-md border transition-colors ${
        selected ? "border-transparent" : "border-line text-ink-mute hover:bg-raised hover:text-ink"
      }`}
      style={selected ? { background: "var(--brand)", color: "var(--brand-ink)" } : undefined}
    >
      {children}
    </button>
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

      <div className="flex flex-wrap items-center gap-2">
        <input
          placeholder="Token label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className={`${inputClass} min-w-[8rem] flex-1`}
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "mcp" | "delivery")}
          className={inputClass}
          style={{ width: "7.5rem", flexShrink: 0 }}
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
  type: FormConnectorType;
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
  /** "byo" | "managed" | null (not connected). */
  mode: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const managed = p.mode === "managed";

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
                : p.status === "provisioning"
                  ? "var(--color-line-strong)"
                  : "var(--color-err)",
          }}
        />
        <p className="text-sm font-medium">Neon Postgres (project database)</p>
        {p.connected && (
          <span className="text-xs text-ink-mute">
            {p.status === "connected"
              ? `${managed ? "managed" : "your database"} — ${p.host ?? "connected"}`
              : p.status}
          </span>
        )}
      </div>

      <p className="mb-3 text-xs text-ink-mute">
        Give this project its own Postgres database — all content (entries, assets
        metadata, history) lives there instead of the shared plane. Provision a
        managed one in one click, or bring your own. Set it up <em>before</em>{" "}
        creating content: existing content is not migrated.
      </p>

      {!managed && (
        <div className="mb-3">
          <label className="mb-1 block text-xs text-ink-mute">
            Bring your own: connection string
            {p.connected ? " (stored — paste again to re-install/heal)" : ""}
          </label>
          <input
            name="connectionString"
            type="password"
            placeholder={p.connected ? "••••••••" : "postgres://user:pass@host/dbname"}
            className={inputClass}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!managed && (
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? "Working…" : p.connected ? "Reconnect" : "Connect"}
          </button>
        )}
        {!p.connected && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setNote(null);
              setError(null);
              const res = await provisionManagedAction(p.projectId);
              setBusy(false);
              setError(res.error ?? null);
              if (!res.error) setNote(res.detail ?? "Provisioned");
            }}
            title="We create and run a dedicated Neon database for this project"
          >
            {busy ? "Provisioning…" : "Provision managed database"}
          </button>
        )}
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
            {managed && p.status !== "connected" && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setNote(null);
                  setError(null);
                  const res = await provisionManagedAction(p.projectId);
                  setBusy(false);
                  setError(res.error ?? null);
                  if (!res.error) setNote(res.detail ?? "Provisioned");
                }}
              >
                Retry provisioning
              </button>
            )}
            {managed ? (
              <button
                type="button"
                className="btn btn-danger-ghost"
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Deprovision this managed database? Its content is DELETED with it (Neon keeps it recoverable for 7 days). The project returns to the shared plane, empty.",
                    )
                  ) {
                    return;
                  }
                  setBusy(true);
                  const res = await deprovisionManagedAction(p.projectId);
                  setBusy(false);
                  setError(res.error ?? null);
                  if (!res.error) setNote(res.detail ?? "Deprovisioned");
                }}
              >
                Deprovision
              </button>
            ) : (
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
            )}
          </>
        )}
        {note && <span className="text-xs text-ink-mute">{note}</span>}
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

/**
 * The storage connector (A4). Like Neon, its own card: Connect runs a live
 * write-then-publicly-read-back probe before anything is stored, which the
 * generic save flow can't do. Managed buckets arrive with A4c.
 */
export function R2ConnectorCard(p: {
  projectId: string;
  connected: boolean;
  status: string;
  bucket: string | null;
  mode: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const managed = p.mode === "managed";

  const fields = [
    { key: "accountId", label: "Cloudflare account ID (32-hex)", placeholder: "8f3a…", type: "text" },
    { key: "accessKeyId", label: "R2 access key ID", placeholder: "", type: "password" },
    { key: "secretAccessKey", label: "R2 secret access key", placeholder: "", type: "password" },
    { key: "bucket", label: "Bucket name", placeholder: "my-site-media", type: "text" },
    {
      key: "publicBaseUrl",
      label: "Public base URL (your custom domain or enabled r2.dev URL)",
      placeholder: "https://media.example.com",
      type: "text",
    },
  ] as const;

  return (
    <form
      action={async (fd) => {
        setBusy(true);
        setNote(null);
        setError(null);
        const res = await connectR2Action(p.projectId, fd);
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
        <p className="text-sm font-medium">R2 storage (project bucket)</p>
        {p.connected && (
          <span className="text-xs text-ink-mute">
            {p.status === "connected" ? `${managed ? "managed" : "your bucket"} — ${p.bucket ?? ""}` : p.status}
          </span>
        )}
      </div>

      <p className="mb-3 text-xs text-ink-mute">
        Keep this project's uploads and image derivatives in its own bucket,
        served from your URL. Connect writes a probe object with your keys and
        reads it back through your public URL before storing anything. Set it up{" "}
        <em>before</em> uploading: existing assets are not migrated.
      </p>

      {!managed &&
        fields.map((f) => (
          <div key={f.key} className="mb-3">
            <label className="mb-1 block text-xs text-ink-mute">{f.label}</label>
            <input name={f.key} type={f.type} placeholder={f.placeholder} className={inputClass} />
          </div>
        ))}

      <div className="flex flex-wrap items-center gap-2">
        {!managed && (
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? "Probing…" : p.connected ? "Reconnect" : "Connect"}
          </button>
        )}
        {!p.connected && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setNote(null);
              setError(null);
              const res = await provisionManagedBucketAction(p.projectId);
              setBusy(false);
              setError(res.error ?? null);
              if (!res.error) setNote(res.detail ?? "Provisioned");
            }}
            title="We create and run a dedicated bucket for this project"
          >
            {busy ? "Provisioning…" : "Provision managed bucket"}
          </button>
        )}
        {p.connected && (
          <>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setNote(null);
                const res = await testConnector(p.projectId, "r2");
                setBusy(false);
                setError(res.error ?? null);
                if (!res.error) setNote(res.ok ? `OK — ${res.detail}` : `Failed — ${res.detail}`);
              }}
            >
              Test
            </button>
            {managed && p.status !== "connected" && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setNote(null);
                  setError(null);
                  const res = await provisionManagedBucketAction(p.projectId);
                  setBusy(false);
                  setError(res.error ?? null);
                  if (!res.error) setNote(res.detail ?? "Provisioned");
                }}
              >
                Retry provisioning
              </button>
            )}
            {managed ? (
              <button
                type="button"
                className="btn btn-danger-ghost"
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Deprovision this managed bucket? Its media is DELETED with it. The project returns to the shared storage plane.",
                    )
                  ) {
                    return;
                  }
                  setBusy(true);
                  const res = await deprovisionManagedBucketAction(p.projectId);
                  setBusy(false);
                  setError(res.error ?? null);
                  if (!res.error) setNote(res.detail ?? "Deprovisioned");
                }}
              >
                Deprovision
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-danger-ghost"
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Disconnect this bucket? Your bucket and its objects are NEVER deleted. Already-uploaded assets keep serving from your URL; new uploads use the shared plane.",
                    )
                  ) {
                    return;
                  }
                  const res = await disconnectConnector(p.projectId, "r2");
                  setError(res.error ?? null);
                  if (!res.error) setNote("Disconnected — your bucket was not touched");
                }}
              >
                Disconnect
              </button>
            )}
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
        className="flex flex-wrap items-center gap-2"
      >
        <input
          name="email"
          type="email"
          placeholder="client@company.com"
          className={`${inputClass} min-w-[8rem] flex-1`}
        />
        <select name="role" defaultValue="client" className={inputClass} style={{ width: "7.5rem", flexShrink: 0 }}>
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

/** Track 2: plugin enablement — the catalog with per-project toggles. */
export function PluginsSection({
  projectId,
  plugins,
}: {
  projectId: string;
  plugins: { id: string; name: string; version: string; description: string; enabled: boolean }[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState(plugins);
  return (
    <div className="space-y-3">
      {state.map((p) => (
        <div key={p.id} className="flex items-start justify-between gap-4 rounded-lg border border-line p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {p.name} <span className="font-mono text-[10px] text-ink-mute">v{p.version}</span>
              {p.enabled && (
                <span className="ml-2 rounded bg-ok/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ok">
                  enabled
                </span>
              )}
            </p>
            <p className="mt-1 text-xs text-ink-soft">{p.description}</p>
          </div>
          <button
            type="button"
            disabled={busy === p.id}
            className={p.enabled ? "btn btn-ghost text-xs" : "btn btn-ink text-xs"}
            onClick={async () => {
              setBusy(p.id);
              setError(null);
              const res = await togglePluginAction(projectId, p.id, !p.enabled);
              setBusy(null);
              if (res.error) setError(res.error);
              else setState((s) => s.map((x) => (x.id === p.id ? { ...x, enabled: !p.enabled } : x)));
            }}
          >
            {busy === p.id ? "…" : p.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      ))}
      {state.length === 0 && <p className="text-sm text-ink-mute">No plugins in the catalog yet.</p>}
      <ErrorLine error={error} />
      <p className="text-xs text-ink-mute">
        Enabling records the capability and unlocks the plugin&apos;s tools; your AI applies its
        structure via MCP (list_plugins → get_plugin).
      </p>
    </div>
  );
}
