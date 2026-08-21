import { PageSkeleton, HeaderSkeleton, TableSkeleton } from "@/components/admin/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton>
      <HeaderSkeleton />
      <TableSkeleton rows={5} />
    </PageSkeleton>
  );
}
