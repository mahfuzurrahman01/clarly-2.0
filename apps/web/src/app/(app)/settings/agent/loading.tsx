import { Skeleton } from "@/components/ui/skeleton";

export default function AgentSettingsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-56 rounded-md" />
        <Skeleton className="h-6 w-32 rounded-full" />
        <Skeleton className="ms-auto h-9 w-28 rounded-md" />
      </div>
      <Skeleton className="h-80 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
