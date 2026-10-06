import { getConsoleSession } from "@/lib/session";
import { listSegments } from "@/lib/api/campaigns";
import { listTemplates } from "@/lib/api/templates";
import { listConnectedNumbers } from "@/lib/api/whatsapp-connect";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { CampaignComposer } from "@/components/campaigns/campaign-composer";

export const dynamic = "force-dynamic";

export default async function NewCampaignPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();

  // Templates come from the existing F12 endpoint — campaigns add no second
  // notion of approval, they read the same records the Templates screen does.
  const [templates, numbers, segments] = await Promise.all([
    listTemplates(undefined, session.token),
    listConnectedNumbers(session.token),
    listSegments(session.token),
  ]);

  return (
    <>
      <PageHeader
        eyebrow={t.campaigns.eyebrow}
        title={t.campaigns.compose.title}
      />
      <div className="mt-8">
        <CampaignComposer
          templates={templates}
          numbers={numbers}
          segments={segments}
        />
      </div>
    </>
  );
}
