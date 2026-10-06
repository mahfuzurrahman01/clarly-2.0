import { Skeleton } from "@/components/ui/skeleton";

export default function OrdersLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <div className="border-b border-border pb-6">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-3 h-9 w-40" />
      </div>
      <Skeleton className="mt-8 h-56 w-full rounded-xl" />
      <div className="mt-8 flex items-center gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="mt-6 space-y-2">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
