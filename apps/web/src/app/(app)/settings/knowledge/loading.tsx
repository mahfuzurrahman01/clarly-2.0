import { Skeleton } from "@/components/ui/skeleton";

export default function KnowledgeLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-9 w-44 rounded-md" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
