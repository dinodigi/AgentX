import { PageSkeleton, HeaderSkeleton, CardGridSkeleton } from "@/components/admin/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton>
      <HeaderSkeleton />
      <CardGridSkeleton n={8} />
    </PageSkeleton>
  );
}
