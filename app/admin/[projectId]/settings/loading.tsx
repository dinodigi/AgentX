import { PageSkeleton, HeaderSkeleton, PanelsSkeleton } from "@/components/admin/Skeleton";

export default function Loading() {
  return (
    <PageSkeleton>
      <HeaderSkeleton />
      <PanelsSkeleton n={4} />
    </PageSkeleton>
  );
}
