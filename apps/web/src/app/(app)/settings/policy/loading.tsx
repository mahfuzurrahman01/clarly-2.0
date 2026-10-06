import { Skeleton } from "@/components/ui/skeleton";

export default function TenantPolicyLoading() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-56 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
    </div>
  );
}
