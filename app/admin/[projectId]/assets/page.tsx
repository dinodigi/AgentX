import Link from "next/link";
import { listAssets } from "@/lib/r2";
import { AssetCard } from "@/components/AssetCard";
import { AssetUploader } from "@/components/AssetUploader";
import { deleteAssetAction } from "../../actions";

const PAGE_SIZE = 60;

/**
 * Media page: every uploaded asset in one grid — previews, upload, delete.
 * Deleting a file that entries still reference is blocked by the data layer;
 * the card surfaces that hint inline.
 */
export default async function AssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { projectId } = await params;
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? 1) || 1);

  const rows = await listAssets(projectId, {
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });
  const hasMore = rows.length > PAGE_SIZE;
  const assets = rows.slice(0, PAGE_SIZE);

  return (
    <>
      <div className="mb-5 flex items-center gap-3">
        <h1 className="display text-xl font-semibold">Media</h1>
        <span className="text-sm text-[--color-ink-mute]">
          {assets.length}
          {hasMore ? "+" : ""} files
        </span>
        <AssetUploader projectId={projectId} />
      </div>

      {assets.length === 0 ? (
        <div className="card p-10 text-center text-sm text-[--color-ink-mute]">
          No files yet — upload one here, or attach files to entries and they&apos;ll
          appear in this library.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((a) => (
            <AssetCard
              key={a.id}
              filename={a.filename}
              contentType={a.contentType}
              size={Number(a.size)}
              url={a.url}
              action={deleteAssetAction.bind(null, projectId, a.id)}
            />
          ))}
        </div>
      )}

      {(page > 1 || hasMore) && (
        <div className="mt-4 flex items-center gap-3 text-sm">
          {page > 1 && (
            <Link href={`/admin/${projectId}/assets?page=${page - 1}`} className="btn">
              ← Prev
            </Link>
          )}
          <span className="text-[--color-ink-mute]">Page {page}</span>
          {hasMore && (
            <Link href={`/admin/${projectId}/assets?page=${page + 1}`} className="btn">
              Next →
            </Link>
          )}
        </div>
      )}
    </>
  );
}
