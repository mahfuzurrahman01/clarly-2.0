import { Skeleton } from "@/components/ui/skeleton";

export default function CatalogLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <div className="border-b border-border pb-6">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-3 h-9 w-40" />
      </div>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-8 w-48" />
      </div>
      <div className="mt-6 space-y-2">
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
