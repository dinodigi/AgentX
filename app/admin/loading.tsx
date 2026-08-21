import { PageSkeleton, HeaderSkeleton, CardGridSkeleton } from "@/components/admin/Skeleton";

/** The fleet dashboard. Heaviest page we have — it fans out to every
 *  connector-backed project — so it is the one that most needed a boundary. */
export default function Loading() {
  return (
    <PageSkeleton>
      <HeaderSkeleton wide />
      <CardGridSkeleton n={6} />
    </PageSkeleton>
  );
}
