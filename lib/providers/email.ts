import "server-only";

/**
 * Email PROVIDER ADAPTERS — the category registry's first real category.
 *
 * The platform speaks one email verb; providers implement it. Everything that
 * used to be a `type === "resend"` branch (send, health probe, key rotation)
 * now lives behind this interface, so adding a provider is: write an adapter,
 * add a map entry. No caller changes, ever.
 *
 * The provider-specific wire shapes are contained ENTIRELY in this file — a
 * wrong assumption about someone's API can't leak into the platform.
 */

export interface EmailMessage {
  /** Resolved sender — the caller has already approved it (senderRefusal). */
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
}

export interface EmailProvider {
  /** Connector type id — also the registry key. */
  id: string;
  label: string;
  /** Send one message. Never throws: failures come back as {ok:false,error}. */
  send(msg: EmailMessage, apiKey: string): Promise<{ ok: boolean; error?: string }>;
  /** Is this key usable? Powers BOTH the health probe and key rotation. */
  verifyKey(apiKey: string): Promise<{ ok: boolean; detail: string }>;
}

const TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 8_000;

const RESEND: EmailProvider = {
  id: "resend",
  label: "Resend",
  async send(msg, apiKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: msg.from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
          ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
          ...(msg.cc?.length ? { cc: msg.cc } : {}),
          ...(msg.bcc?.length ? { bcc: msg.bcc } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
  async verifyKey(apiKey) {
    try {
      const res = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return res.ok
        ? { ok: true, detail: "API key valid" }
        : { ok: false, detail: `Resend returned HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
};

/**
 * Elastic Email v4. Wire shape verified against their REST API docs
 * (POST /v4/emails/transactional with Recipients/Content). Their docs and help
 * center disagree on the auth header — the API reference says
 * `Authorization: Bearer`, the help center says `X-ElasticEmail-ApiKey` — so we
 * send BOTH: they're independent headers, and a doc drift on either one can't
 * break live sends.
 */
const ELASTIC_EMAIL: EmailProvider = {
  id: "elastic_email",
  label: "Elastic Email",
  async send(msg, apiKey) {
    const body: Record<string, unknown> = {
      Recipients: {
        To: [msg.to],
        ...(msg.cc?.length ? { CC: msg.cc } : {}),
        ...(msg.bcc?.length ? { BCC: msg.bcc } : {}),
      },
      Content: {
        From: msg.from,
        Subject: msg.subject,
        ...(msg.replyTo ? { ReplyTo: msg.replyTo } : {}),
        Body: [
          { ContentType: "PlainText", Content: msg.text },
          ...(msg.html ? [{ ContentType: "HTML", Content: msg.html }] : []),
        ],
      },
    };
    try {
      const res = await fetch("https://api.elasticemail.com/v4/emails/transactional", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-ElasticEmail-ApiKey": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `Elastic Email HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
  async verifyKey(apiKey) {
    try {
      // The docs' suggested lightweight account-level call. A send-only key
      // (Access Level: SendHttp) can legitimately be REFUSED here — 403 means
      // "key is real but scoped narrowly", which must not read as a bad key,
      // or every send-only setup would show a false red health dot.
      const res = await fetch("https://api.elasticemail.com/v4/lists?limit=1", {
        headers: { Authorization: `Bearer ${apiKey}`, "X-ElasticEmail-ApiKey": apiKey },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, detail: "API key valid" };
      if (res.status === 403) {
        return { ok: true, detail: "API key accepted (send-only scope — cannot read account lists)" };
      }
      return { ok: false, detail: `Elastic Email returned HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
};

/**
 * The registry. ORDER IS THE TIEBREAK: if a project somehow has two email
 * connectors (legal in the DB before the one-per-category rule existed), the
 * first entry wins — deterministic, and it keeps every pre-existing Resend
 * project on exactly the provider it has been using.
 */
export const EMAIL_PROVIDERS: EmailProvider[] = [RESEND, ELASTIC_EMAIL];

export const EMAIL_PROVIDER_IDS = EMAIL_PROVIDERS.map((p) => p.id);

export function emailProvider(id: string): EmailProvider | null {
  return EMAIL_PROVIDERS.find((p) => p.id === id) ?? null;
}
