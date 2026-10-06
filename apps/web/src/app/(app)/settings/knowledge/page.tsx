import { getConsoleSession } from "@/lib/session";
import { listKbDocuments } from "@/lib/api/knowledge-base";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { KbManager } from "@/components/settings/kb-manager";

export const dynamic = "force-dynamic";

export default async function KnowledgeSettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const documents = await listKbDocuments(session.token);

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t.settings.eyebrow} title={t.settings.kbTitle} />
      <div className="max-w-prose">
        <p className="text-sm text-muted-foreground">
          {t.settings.kbIntroPrefix}
          <code className="text-xs">.txt</code>, <code className="text-xs">.md</code>
          {t.settings.kbIntroMid}
          <span className="text-lime-text">{t.settings.ready}</span>.
        </p>
      </div>
      <KbManager initial={documents} />
    </div>
  );
}
