import type { Collection } from "@/db/schema";
import type { FieldDef } from "@/lib/field-types";

/**
 * get_client_code generator: a typed, dependency-free TS client for the
 * delivery API, built from the live schema. Everything is derived from the
 * collection defs + the capability tables below, so when the query layer
 * (subsystem 04) grows new operators, extending FILTERABLE/opts here
 * regenerates every client for free.
 *
 * The client targets the DELIVERY surface (what a site holds: a
 * delivery-scoped token), not MCP — reads return only publicRead fields,
 * writes go through the same gates as any site.
 */

// Delivery-API filter capability: equality on public fields, except richtext
// (its only operator is `contains`, which the delivery API doesn't expose yet).
// Subsystem 04 extends this table.
function filterable(f: FieldDef): boolean {
  return f.type !== "richtext";
}

function pascal(slug: string): string {
  return slug
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/** TS type of a field as it appears in READ results (public view). */
function readType(f: FieldDef): string {
  switch (f.type) {
    case "text":
    case "richtext":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "string"; // ISO
    case "enum":
      return (f.options ?? []).map((o) => JSON.stringify(o)).join(" | ") || "string";
    case "asset":
      return "{ id: string; url: string; contentType: string }";
    case "relation":
      return "{ id: string; label: string }";
  }
}

/** TS type of a field as it is WRITTEN (asset/relation values are ids). */
function writeType(f: FieldDef): string {
  if (f.type === "asset" || f.type === "relation") return "string";
  return readType(f);
}

interface CollectionPlan {
  slug: string;
  typeName: string;
  fields: FieldDef[];
  publicFields: FieldDef[];
  ownerField: string | null;
  canRead: boolean;
  canCreate: boolean;
  canMutate: boolean;
  canUpload: boolean;
  needsUser: boolean;
}

function plan(c: Collection): CollectionPlan {
  const publicFieldDefs = c.fields.filter((f) => f.publicRead);
  const write = c.access?.write ?? "none";
  const canCreate = Boolean(c.publicWrite) || write !== "none";
  return {
    slug: c.name,
    typeName: pascal(c.name),
    fields: c.fields,
    publicFields: publicFieldDefs,
    ownerField: c.access?.ownerField ?? null,
    canRead: publicFieldDefs.length > 0,
    canCreate,
    canMutate: write === "owner",
    canUpload: canCreate && c.fields.some((f) => f.type === "asset"),
    needsUser: (c.access?.read ?? "public") !== "public" || write !== "none",
  };
}

function fieldLines(fields: FieldDef[], typeOf: (f: FieldDef) => string, forceOptional = false): string {
  return fields
    .map((f) => `  ${f.name}${f.required && !forceOptional ? "" : "?"}: ${typeOf(f)};`)
    .join("\n");
}

function typeBlock(p: CollectionPlan): string {
  const parts: string[] = [];
  if (p.canRead) {
    parts.push(
      `/** ${p.slug} — public view; only publicRead fields are ever returned. */`,
      `export interface ${p.typeName} {`,
      `  id: string;`,
      fieldLines(p.publicFields, readType),
      `}`,
    );
    const filters = p.publicFields.filter(filterable);
    parts.push(
      ``,
      `export interface ${p.typeName}ListOpts {`,
      `  /** Equality filters on public fields. */`,
      filters.length
        ? `  filter?: {\n${fieldLines(filters, writeType, true).replace(/^ {2}/gm, "    ")}\n  };`
        : `  filter?: Record<string, never>;`,
      p.publicFields.length
        ? `  sort?: { field: ${p.publicFields.map((f) => JSON.stringify(f.name)).join(" | ")}; dir: "asc" | "desc" };`
        : ``,
      `  limit?: number;`,
      `  offset?: number;`,
      `}`,
    );
  }
  if (p.canCreate || p.canMutate) {
    const writable = p.fields.filter((f) => f.name !== p.ownerField);
    parts.push(
      ``,
      `/** ${p.slug} — write shape (relations/assets by id${p.ownerField ? `; "${p.ownerField}" is stamped server-side` : ""}). */`,
      `export interface ${p.typeName}Create {`,
      fieldLines(writable, writeType),
      `}`,
      ``,
      `export type ${p.typeName}Update = Partial<${p.typeName}Create>;`,
    );
  }
  return parts.filter((s) => s !== ``).join("\n").replace(/\n\n+/g, "\n\n");
}

function accessorBlock(p: CollectionPlan): string {
  const methods: string[] = [];
  if (p.canRead) {
    methods.push(
      `      async list(opts: ${p.typeName}ListOpts = {}): Promise<${p.typeName}[]> {
        const query: Record<string, unknown> = { limit: opts.limit, offset: opts.offset, ...(opts.filter ?? {}) };
        if (opts.sort) query.sort = opts.sort.field + ":" + opts.sort.dir;
        return (await request<{ data: ${p.typeName}[] }>("GET", "/${p.slug}", query)).data;
      },`,
      `      async get(id: string): Promise<${p.typeName}> {
        return (await request<{ data: ${p.typeName} }>("GET", "/${p.slug}/" + encodeURIComponent(id))).data;
      },`,
    );
  }
  if (p.canCreate) {
    methods.push(
      `      async create(data: ${p.typeName}Create): Promise<{ id: string }> {
        return request<{ id: string }>("POST", "/${p.slug}", undefined, data);
      },`,
    );
  }
  if (p.canUpload) {
    methods.push(
      `      /** Upload a file, then reference the returned id in an asset field. */
      async upload(file: Blob, filename = "upload"): Promise<{ id: string; url: string }> {
        const fd = new FormData();
        fd.append("file", file, filename);
        const headers: Record<string, string> = { authorization: "Bearer " + options.token };
        if (userToken) headers["x-user-token"] = userToken;
        const res = await fetch(baseUrl + "/${p.slug}/uploads", { method: "POST", headers, body: fd });
        const json = (await res.json().catch(() => null)) as
          | { id?: string; url?: string; error?: string; code?: string }
          | null;
        if (!res.ok) throw new AgentXError(res.status, json?.error ?? "HTTP " + res.status, json?.code);
        return json as { id: string; url: string };
      },`,
    );
  }
  if (p.canMutate) {
    methods.push(
      `      async update(id: string, patch: ${p.typeName}Update): Promise<${p.typeName}> {
        return (await request<{ data: ${p.typeName} }>("PATCH", "/${p.slug}/" + encodeURIComponent(id), undefined, patch)).data;
      },`,
      `      async remove(id: string): Promise<void> {
        await request<void>("DELETE", "/${p.slug}/" + encodeURIComponent(id));
      },`,
    );
  }
  const note = p.needsUser ? " // requires setUserToken() for non-public access" : "";
  return `    ${p.slug}: {${note}\n${methods.join("\n")}\n    },`;
}

export function generateClientCode(opts: {
  projectName: string;
  deliveryBase: string;
  collections: Collection[];
}): { code: string; collections: string[]; skipped: string[] } {
  const plans = opts.collections.map(plan);
  const included = plans.filter((p) => p.canRead || p.canCreate);
  const skipped = plans.filter((p) => !p.canRead && !p.canCreate).map((p) => p.slug);

  const header = `/**
 * AgentX delivery-API client for "${opts.projectName}" — GENERATED CODE.
 * Regenerate with the get_client_code MCP tool after any schema change;
 * do not edit by hand.
 *
 * Usage:
 *   const ax = createClient({ token: process.env.AGENTX_DELIVERY_TOKEN! });
 *   const rows = await ax.${included[0]?.slug ?? "your_collection"}.list();
 *
 * The token is a delivery-scoped project token — keep it server-side.
 * Collections with authenticated/owner access rules also need the signed-in
 * user's JWT: call ax.setUserToken(jwt) (sent as X-User-Token).
 * Errors throw AgentXError with the HTTP status, the server's message, and a
 * stable machine code (E_VALIDATION, E_AUTH, E_NOT_FOUND, E_RATE_LIMITED, …).
 */

const DEFAULT_BASE_URL = ${JSON.stringify(opts.deliveryBase)};

export interface AgentXClientOptions {
  /** Delivery API base; defaults to the deployment this client was generated from. */
  baseUrl?: string;
  /** Delivery-scoped project token (agx_...). */
  token: string;
  /** End-user JWT for authenticated/owner collections. */
  userToken?: string | null;
}

export class AgentXError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = "AgentXError";
  }
}

/** One change from the realtime feed. \`data\` holds only publicRead fields;
 *  kind:"deleted" carries no data. Treat an unknown id as an upsert. */
export interface ChangeEvent {
  cursor: string;
  collection: string;
  id: string;
  kind: "created" | "updated" | "deleted";
  at: string;
  changedFields?: string[];
  data?: Record<string, unknown>;
}`;

  const factory = `export function createClient(options: AgentXClientOptions) {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\\/+$/, "");
  let userToken = options.userToken ?? null;

  async function request<T>(
    method: string,
    path: string,
    query?: Record<string, unknown>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { authorization: "Bearer " + options.token };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (userToken) headers["x-user-token"] = userToken;
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    if (!res.ok) throw new AgentXError(res.status, json?.error ?? "HTTP " + res.status, json?.code);
    return json as T;
  }

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = { authorization: "Bearer " + options.token };
    if (userToken) h["x-user-token"] = userToken;
    return h;
  }

  /** One page of the change feed. Persist \`cursor\` and pass it as \`since\` next
   *  time; \`ifNoneMatch\` (the previous ETag) yields notModified when idle. */
  async function pollChanges(opts: { since?: string; collections?: string[]; ifNoneMatch?: string } = {}) {
    const url = new URL(baseUrl + "/changes");
    if (opts.since) url.searchParams.set("since", opts.since);
    if (opts.collections?.length) url.searchParams.set("collections", opts.collections.join(","));
    const headers = authHeaders();
    if (opts.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch;
    const res = await fetch(url.toString(), { headers });
    const etag = res.headers.get("etag") ?? undefined;
    if (res.status === 304) return { changes: [] as ChangeEvent[], cursor: opts.since ?? "", hasMore: false, notModified: true, etag };
    const json = (await res.json().catch(() => null)) as
      | { changes?: ChangeEvent[]; cursor?: string; hasMore?: boolean; error?: string; code?: string }
      | null;
    if (!res.ok) throw new AgentXError(res.status, json?.error ?? "HTTP " + res.status, json?.code);
    return { changes: json?.changes ?? [], cursor: json?.cursor ?? "", hasMore: Boolean(json?.hasMore), notModified: false, etag };
  }

  return {
    /** Swap the end-user JWT after login/logout. */
    setUserToken(t: string | null) {
      userToken = t;
    },

    /**
     * Realtime change feed (PULL, not push). \`poll\` fetches changes since a
     * cursor (persist it); \`stream\` consumes SSE with automatic ?since resume
     * across the bounded-lifetime reconnects and a poll fallback. RECONCILE: on a
     * gap, a whole-collection delete, or a field rename, do a full .list() — the
     * feed is near-exact, not guaranteed-complete. Treat an unknown id as upsert.
     */
    changes: {
      poll: pollChanges,
      /** Consume the SSE stream, invoking onChange per event. Returns a stop fn. */
      stream(onChange: (c: ChangeEvent) => void, opts: { since?: string; collections?: string[] } = {}): () => void {
        let cursor = opts.since;
        let stopped = false;
        (async () => {
          while (!stopped) {
            try {
              const url = new URL(baseUrl + "/changes/stream");
              if (cursor) url.searchParams.set("since", cursor);
              if (opts.collections?.length) url.searchParams.set("collections", opts.collections.join(","));
              const res = await fetch(url.toString(), { headers: authHeaders() });
              if (!res.ok || !res.body) throw new AgentXError(res.status, "stream failed");
              const reader = res.body.getReader();
              const dec = new TextDecoder();
              let buf = "";
              while (!stopped) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let i: number;
                while ((i = buf.indexOf("\\n\\n")) >= 0) {
                  const frame = buf.slice(0, i);
                  buf = buf.slice(i + 2);
                  const id = /^id: (.+)$/m.exec(frame)?.[1];
                  const ev = /^event: (.+)$/m.exec(frame)?.[1];
                  const data = /^data: (.+)$/m.exec(frame)?.[1];
                  if (id) cursor = id;
                  if (ev === "change" && data) onChange(JSON.parse(data) as ChangeEvent);
                  else if (ev === "cursor" && data) cursor = (JSON.parse(data) as { cursor: string }).cursor;
                }
              }
            } catch {
              // Fall back to a poll (also advances the cursor), then reconnect.
              try {
                const p = await pollChanges({ since: cursor });
                for (const c of p.changes) onChange(c);
                if (p.cursor) cursor = p.cursor;
              } catch {
                /* keep trying */
              }
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
        })();
        return () => {
          stopped = true;
        };
      },
    },
${included.map(accessorBlock).join("\n")}
  };
}`;

  const code = [header, included.map(typeBlock).join("\n\n"), factory].join("\n\n") + "\n";
  return { code, collections: included.map((p) => p.slug), skipped };
}
