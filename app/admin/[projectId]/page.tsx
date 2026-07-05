import Link from "next/link";
import { count, eq } from "drizzle-orm";
import { Inbox, Table2 } from "lucide-react";
import { db } from "@/db";
import { entries } from "@/db/schema";
import { listCollections } from "@/lib/collections";

/**
 * Project overview: every collection the AI defined, with entry counts.
 * Counts come from ONE grouped query, not one per collection.
 */
export default async function ProjectHome({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [collections, counts] = await Promise.all([
    listCollections(projectId),
    db
      .select({ collectionId: entries.collectionId, n: count() })
      .from(entries)
      .where(eq(entries.projectId, projectId))
      .groupBy(entries.collectionId),
  ]);
  const countById = new Map(counts.map((c) => [c.collectionId, c.n]));

  return (
    <>
      <p className="eyebrow mb-1">Workspace</p>
      <h1 className="display mb-5 text-xl font-semibold">Collections</h1>
      {collections.length === 0 && (
        <div className="card p-10 text-center">
          <p className="display font-semibold">Define your first collection</p>
          <p className="mt-1.5 text-sm text-[--color-ink-mute]">
            Connect Claude Code to the MCP endpoint and describe your data model —
            it appears here instantly.
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        {collections.map((c) => (
          <Link key={c.id} href={`/admin/${projectId}/${c.name}`} className="card group p-5">
            <div className="flex items-center gap-2.5">
              {c.publicWrite ? (
                <Inbox className="h-4 w-4 text-brand" />
              ) : (
                <Table2 className="h-4 w-4 text-brand" />
              )}
              <span className="display font-semibold">{c.displayName}</span>
            </div>
            <p className="mt-1.5 text-[13px] text-[--color-ink-mute]">
              {countById.get(c.id) ?? 0} entries · {c.fields.length} fields
              {c.publicWrite ? " · public form" : ""}
            </p>
          </Link>
        ))}
      </div>
    </>
  );
}
