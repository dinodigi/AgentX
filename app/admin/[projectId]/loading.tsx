import { ProjectPageSkeleton } from "@/components/admin/Skeleton";

/** Default for every project sub-route without its own boundary. Renders inside
 *  the layout's <main>, so it must not redraw any chrome. */
export default function Loading() {
  return <ProjectPageSkeleton />;
}
