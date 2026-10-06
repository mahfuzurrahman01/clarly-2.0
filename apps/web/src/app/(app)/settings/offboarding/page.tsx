import { getConsoleSession } from "@/lib/session";
import { getClosureStatus } from "@/lib/api/onboarding";
import { PageHeader } from "@/components/shell/page-header";
import { TenantOffboardManager } from "@/components/settings/tenant-offboard-manager";

export const dynamic = "force-dynamic";

export default async function OffboardingSettingsPage() {
  const session = await getConsoleSession();
  const closure = await getClosureStatus(session.token);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Danger zone"
        title="Workspace offboarding"
        description="Close your workspace and permanently erase all data. This action requires admin access."
      />
      <TenantOffboardManager initialClosure={closure} />
    </div>
  );
}
