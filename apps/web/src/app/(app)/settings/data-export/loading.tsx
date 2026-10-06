import { Skeleton } from "@/components/ui/skeleton";

export default function DataExportLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
    </div>
  );
}
