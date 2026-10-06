import { Skeleton } from "@/components/ui/skeleton";

export default function TicketsLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <div className="border-b border-border pb-6">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-3 h-9 w-40" />
      </div>
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((col) => (
          <div key={col} className="flex flex-col gap-3">
            <Skeleton className="h-5 w-20" />
            {[0, 1, 2].map((c) => (
              <Skeleton key={c} className="h-32 w-full rounded-xl" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
