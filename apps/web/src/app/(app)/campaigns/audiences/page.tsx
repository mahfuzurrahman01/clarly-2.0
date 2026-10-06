import { getConsoleSession } from "@/lib/session";
import { listSegments } from "@/lib/api/campaigns";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { AudienceManager } from "@/components/campaigns/audience-manager";

export const dynamic = "force-dynamic";

export default async function AudiencesPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const segments = await listSegments(session.token);

  return (
    <>
      <PageHeader
        eyebrow={t.campaigns.eyebrow}
        title={t.campaigns.segment.title}
      />
      <div className="mt-8">
        <AudienceManager initial={segments} />
      </div>
    </>
  );
}
