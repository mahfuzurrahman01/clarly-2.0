import { getConsoleSession } from "@/lib/session";
import {
  DEFAULT_STUCK_TICKET_THRESHOLD_MINUTES,
  getTenantPolicy,
} from "@/lib/api/tenant-policy";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { TenantPolicyManager } from "@/components/settings/tenant-policy-manager";

export const dynamic = "force-dynamic";

export default async function TenantPolicySettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const policy = await getTenantPolicy(session.token);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.tenantPolicy.eyebrow}
        title={t.tenantPolicy.title}
        description={t.tenantPolicy.description}
      />
      <TenantPolicyManager
        initialStuckTicketMinutes={
          policy?.stuckTicketThresholdMinutes ?? DEFAULT_STUCK_TICKET_THRESHOLD_MINUTES
        }
        initialRerankEnabled={policy?.rerankEnabled ?? false}
      />
    </div>
  );
}
