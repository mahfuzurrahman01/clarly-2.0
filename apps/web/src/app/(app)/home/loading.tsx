import { Skeleton } from "@/components/ui/skeleton";

export default function HomeLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <div className="border-b border-border pb-6">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-3 h-9 w-52" />
      </div>
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((c) => (
          <Skeleton key={c} className="h-28 w-full rounded-xl" />
        ))}
      </div>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((c) => (
          <Skeleton key={c} className="h-44 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
