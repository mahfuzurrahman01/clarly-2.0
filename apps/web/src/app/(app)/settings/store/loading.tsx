import { Skeleton } from "@/components/ui/skeleton";

export default function StoreSettingsLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
