import { getConsoleSession } from "@/lib/session";
import { listAuditLog } from "@/lib/api/audit-log";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { AuditLogViewer } from "@/components/settings/audit-log-viewer";

export const dynamic = "force-dynamic";

export default async function AuditLogSettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const entries = await listAuditLog({ limit: 50 }, session.token);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.auditLog.eyebrow}
        title={t.auditLog.title}
        description={t.auditLog.description}
      />
      <AuditLogViewer initialEntries={entries} />
    </div>
  );
}
