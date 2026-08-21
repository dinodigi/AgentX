import { Bar } from "@/components/admin/Skeleton";

/** The schema map claims the full viewport and has its own chrome, so its
 *  skeleton mirrors that shape rather than the standard page padding. */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading schema map" className="-mx-5 -my-7 flex h-[calc(100vh-52px)] flex-col md:-mx-10 md:-my-9">
      <span className="sr-only">Loading…</span>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-6 py-4">
        <div className="flex flex-col gap-1.5">
          <Bar w="w-36" h="h-5" />
          <Bar w="w-52" h="h-3" />
        </div>
        <Bar w="w-56" h="h-8" className="rounded-lg" />
      </div>
      <div className="min-h-0 flex-1 bg-raised/40" />
      <div className="shrink-0 border-t border-line px-6 py-3">
        <Bar w="w-80" h="h-3" />
      </div>
    </div>
  );
}
