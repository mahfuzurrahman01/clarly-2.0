import { getConsoleSession } from "@/lib/session";
import { listTemplates } from "@/lib/api/templates";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { TemplatesManager } from "@/components/settings/templates-manager";

export const dynamic = "force-dynamic";

export default async function TemplatesSettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const templates = await listTemplates(undefined, session.token);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.templates.eyebrow}
        title={t.templates.title}
        description={t.templates.description}
      />
      <TemplatesManager initialTemplates={templates} />
    </div>
  );
}
