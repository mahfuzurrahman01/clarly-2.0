import { Skeleton } from "@/components/ui/skeleton";

export default function InsightsLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <Skeleton className="h-8 w-48" />
      <div className="mt-8 space-y-10">
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </div>
  );
}
