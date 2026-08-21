import { PageSkeleton, HeaderSkeleton, TableSkeleton } from "@/components/admin/Skeleton";

/** Entry lists — the surface an operator opens most, and the one whose row
 *  count varies enough that a blank pause is most noticeable. */
export default function Loading() {
  return (
    <PageSkeleton>
      <HeaderSkeleton />
      <TableSkeleton rows={8} />
    </PageSkeleton>
  );
}
