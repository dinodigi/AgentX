import { PageSkeleton, HeaderSkeleton, CardGridSkeleton, PanelsSkeleton } from "@/components/admin/Skeleton";

/** Project overview. Also the DEFAULT boundary for every project sub-route that
 *  does not declare its own — a segment inherits its parent's loading UI. */
export default function Loading() {
  return (
    <PageSkeleton>
      <HeaderSkeleton />
      <div className="mb-5">
        <CardGridSkeleton n={3} />
      </div>
      <PanelsSkeleton n={2} />
    </PageSkeleton>
  );
}
