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
      <h1 className="mb-4 text-lg font-medium">Collections</h1>
      {collections.length === 0 && (
        <div className="rounded-xl border border-gray-200 p-8 text-center">
          <p className="font-medium">Define your first collection</p>
          <p className="mt-1 text-sm text-gray-500">
            Connect Claude Code to the MCP endpoint and describe your data model —
            it appears here instantly.
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {collections.map((c) => (
          <Link
            key={c.id}
            href={`/admin/${projectId}/${c.name}`}
            className="rounded-xl border border-gray-200 p-4 hover:border-gray-300"
          >
            <div className="flex items-center gap-2">
              {c.publicWrite ? (
                <Inbox className="h-4 w-4 text-brand" />
              ) : (
                <Table2 className="h-4 w-4 text-brand" />
              )}
              <span className="font-medium">{c.displayName}</span>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              {countById.get(c.id) ?? 0} entries · {c.fields.length} fields
              {c.publicWrite ? " · public form" : ""}
            </p>
          </Link>
        ))}
      </div>
    </>
  );
}
