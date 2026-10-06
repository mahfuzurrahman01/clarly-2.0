import { Skeleton } from "@/components/ui/skeleton";

export default function InboxLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <div className="border-b border-border pb-6">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-3 h-9 w-32" />
      </div>
      <div className="mt-8 space-y-3">
        <Skeleton className="h-9 w-full max-w-xs" />
        <div className="overflow-hidden rounded-xl border border-border">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="border-b border-border p-4 last:border-0">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-2 h-3 w-64" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
