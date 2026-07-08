import { listCollections } from "@/lib/collections";
import { publicFields } from "@/lib/entries";
import type { Collection } from "@/db/schema";
import type { FieldDef } from "@/lib/field-types";
import type { WhereClause, WhereItem } from "@/lib/query";

function describeClause(c: WhereClause): string {
  return `${c.field} ${c.op} ${Array.isArray(c.value) ? c.value.join("|") : c.value}`;
}
function describeWhereItem(item: WhereItem): string {
  return "anyOf" in item
    ? `(${item.anyOf.map(describeClause).join(" OR ")})`
    : describeClause(item);
}

/**
 * Auto-generated API reference — rendered straight from the schema registry.
 * What a site developer reads to wire the front end; zero maintenance.
 */
export default async function ApiReference({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const collections = await listCollections(projectId);

  return (
    <>
      <h1 className="display mb-1 text-xl font-semibold">API reference</h1>
      <p className="mb-2 text-sm text-[--color-ink-mute]">
        All requests need a project token (use a delivery-scoped one in sites):{" "}
        <code className="rounded bg-[--color-paper] px-1.5 py-0.5 font-mono text-xs">
          Authorization: Bearer agx_…
        </code>
      </p>
      <p className="mb-6 text-sm text-[--color-ink-mute]">
        Collections with access rules also need the signed-in user&apos;s JWT:{" "}
        <code className="rounded bg-[--color-paper] px-1.5 py-0.5 font-mono text-xs">
          X-User-Token: &lt;jwt&gt;
        </code>{" "}
        — issued by this project&apos;s connected Clerk instance.
      </p>

      <div className="card mb-6 max-w-2xl p-4">
        <p className="mb-1 text-sm font-medium">Verifying webhooks</p>
        <p className="text-xs leading-relaxed text-[--color-ink-mute]">
          Every webhook carries{" "}
          <code className="font-mono">X-AgentX-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>{" "}
          where <code className="font-mono">v1 = HMAC_SHA256(secret, t + &quot;.&quot; + body)</code>.
          Recompute with the signing secret from Settings, compare constant-time, and
          reject stale timestamps (&gt;5 min).
        </p>
      </div>

      {collections.length === 0 && (
        <p className="rounded-lg border border-[--color-line] p-4 text-sm text-[--color-ink-mute]">
          No collections defined yet.
        </p>
      )}

      <div className="space-y-6">
        {collections.map((c) => (
          <CollectionDocs key={c.name} collection={c} />
        ))}
      </div>
    </>
  );
}

function Method({ verb, tone }: { verb: string; tone: "get" | "post" | "mut" }) {
  const cls =
    tone === "get"
      ? "bg-brand-soft text-brand-strong"
      : tone === "post"
        ? "bg-amber-50 text-amber-800"
        : "bg-[--color-paper] text-[--color-ink-soft]";
  return (
    <span className={`mr-2 rounded px-1.5 py-0.5 font-mono text-xs font-medium ${cls}`}>
      {verb}
    </span>
  );
}

function CollectionDocs({ collection }: { collection: Collection }) {
  const pub = publicFields(collection);
  // access presets may be a preset string, a {claim,equals} rule, or an any-of
  // array — render a compact human label rather than the raw shape.
  const presetLabel = (v: unknown): string => {
    const one = (p: unknown): string => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object" && "claim" in p) {
        const r = p as { claim: string; equals: string | string[] };
        return `${r.claim}=${[r.equals].flat().join("/")}`;
      }
      return "rule";
    };
    return Array.isArray(v) ? v.map(one).join(" or ") : one(v);
  };
  const read = presetLabel(collection.access?.read ?? "public");
  const write = presetLabel(collection.access?.write ?? "none");
  const eventCount = ["created", "updated", "deleted"].reduce(
    (n, k) => n + (collection.events?.[k as "created"]?.length ?? 0),
    0,
  );

  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="font-medium">{collection.displayName}</p>
        {read !== "public" && (
          <span className="chip chip-brand">
            read: {read}
          </span>
        )}
        {write !== "none" && (
          <span className="chip chip-brand">
            write: {write}
          </span>
        )}
        {collection.publicFilter?.length ? (
          <span className="chip chip-mute">
            row filter: {collection.publicFilter.map(describeWhereItem).join(", ")}
          </span>
        ) : null}
        {eventCount > 0 && (
          <span className="chip chip-mute">
            {eventCount} event action{eventCount > 1 ? "s" : ""}
          </span>
        )}
      </div>

      {pub.length > 0 ? (
        <div className="mb-4">
          <p className="mb-1.5 text-sm">
            <Method verb="GET" tone="get" />
            <code className="font-mono text-sm">/api/v1/{collection.name}</code>
          </p>
          <p className="mb-2 text-xs text-[--color-ink-mute]">
            Public fields only{read === "owner" ? ", scoped to the signed-in user's rows" : ""}.
            Relations → <code className="font-mono">{"{id,label}"}</code>, assets →{" "}
            <code className="font-mono">{"{id,url}"}</code>. Filters:{" "}
            <code className="font-mono">?{pub[0]?.name}=value</code> · sort:{" "}
            <code className="font-mono">?sort={pub[0]?.name}:asc</code> · paging:{" "}
            <code className="font-mono">?limit=&offset=</code>
          </p>
          <pre className="overflow-x-auto rounded-lg bg-[--color-paper] p-3 font-mono text-xs leading-relaxed text-[--color-ink-soft]">
            {sampleResponse(pub)}
          </pre>
          <p className="mt-1.5 text-xs text-[--color-ink-mute]">
            <Method verb="GET" tone="get" />
            <code className="font-mono">/api/v1/{collection.name}/{"{id}"}</code> — single entry,
            same rules.
          </p>
        </div>
      ) : (
        <p className="mb-4 text-xs text-[--color-ink-mute]">
          No public fields — this collection is not readable from the delivery API.
        </p>
      )}

      {(collection.publicWrite || write !== "none") && (
        <div className="mb-1">
          <p className="mb-1.5 text-sm">
            <Method verb="POST" tone="post" />
            <code className="font-mono text-sm">/api/v1/{collection.name}</code>
          </p>
          <p className="mb-2 text-xs text-[--color-ink-mute]">
            {collection.publicWrite && write === "none"
              ? "Anonymous submissions allowed (public form)."
              : `Requires a signed-in user (X-User-Token)${
                  collection.access?.ownerField
                    ? `; ${collection.access.ownerField} is stamped from the verified user`
                    : ""
                }.`}{" "}
            Validated server-side; fires event actions. Required:{" "}
            {collection.fields.filter((f) => f.required).map((f) => f.name).join(", ") || "none"}.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-[--color-paper] p-3 font-mono text-xs leading-relaxed text-[--color-ink-soft]">
            {samplePayload(collection.fields)}
          </pre>
        </div>
      )}

      {write === "owner" && (
        <p className="mt-2 text-xs text-[--color-ink-mute]">
          <Method verb="PATCH" tone="mut" />
          <Method verb="DELETE" tone="mut" />
          <code className="font-mono">/api/v1/{collection.name}/{"{id}"}</code> — signed-in owner
          only; ownership cannot be transferred.
        </p>
      )}
    </div>
  );
}

function sampleValue(f: FieldDef): unknown {
  switch (f.type) {
    case "text":
      return "…";
    case "richtext":
      return "<p>…</p>";
    case "number":
      return 42;
    case "boolean":
      return true;
    case "date":
      return "2026-07-04T12:00:00Z";
    case "enum":
      return f.options[0];
    case "asset":
      return { id: "asset-uuid", url: "https://…" };
    case "relation":
      return { id: "entry-uuid", label: "…" };
  }
}

function sampleResponse(fields: FieldDef[]): string {
  const row: Record<string, unknown> = { id: "entry-uuid" };
  for (const f of fields) row[f.name] = sampleValue(f);
  return JSON.stringify({ data: [row] }, null, 2);
}

function samplePayload(fields: FieldDef[]): string {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === "relation" || f.type === "asset") body[f.name] = "uuid";
    else body[f.name] = sampleValue(f);
  }
  return JSON.stringify(body, null, 2);
}
