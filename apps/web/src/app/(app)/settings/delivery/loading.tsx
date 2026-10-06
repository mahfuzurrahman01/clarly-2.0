import { Skeleton } from "@/components/ui/skeleton";

export default function DeliverySettingsLoading() {
  return (
    <div className="space-y-10">
      <div className="border-b border-border pb-6">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-3 h-9 w-44" />
        <Skeleton className="mt-3 h-4 w-80" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-44 w-full rounded-xl" />
      </div>
    </div>
  );
}
