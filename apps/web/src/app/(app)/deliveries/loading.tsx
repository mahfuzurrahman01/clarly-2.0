import { Skeleton } from "@/components/ui/skeleton";

export default function DeliveriesLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <div className="border-b border-border pb-6">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-3 h-9 w-44" />
        <Skeleton className="mt-3 h-4 w-96" />
      </div>
      <div className="mt-8 space-y-6">
        <Skeleton className="h-28 w-full rounded-xl" />
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
