import { getConsoleSession } from "@/lib/session";
import { listDataExports } from "@/lib/api/data-exports";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { DataExportManager } from "@/components/settings/data-export-manager";

export const dynamic = "force-dynamic";

export default async function DataExportSettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const exports = await listDataExports(session.token);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.dataExports.eyebrow}
        title={t.dataExports.title}
        description={t.dataExports.description}
      />
      <DataExportManager initialExports={exports} />
    </div>
  );
}
