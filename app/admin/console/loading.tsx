import { PageSkeleton, HeaderSkeleton, TableSkeleton } from "@/components/admin/Skeleton";

/** Operator console — cross-tenant queries, so it is genuinely slow. */
export default function Loading() {
  return (
    <PageSkeleton>
      <HeaderSkeleton wide />
      <TableSkeleton rows={10} />
    </PageSkeleton>
  );
}
