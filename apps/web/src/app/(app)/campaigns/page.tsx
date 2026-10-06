import Link from "next/link";
import { Plus, Users } from "lucide-react";
import { getConsoleSession } from "@/lib/session";
import { CAMPAIGNS_PAGE_SIZE, listCampaigns } from "@/lib/api/campaigns";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { CampaignsList } from "@/components/campaigns/campaigns-list";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();

  const initial = await listCampaigns(
    { limit: CAMPAIGNS_PAGE_SIZE, offset: 0 },
    session.token,
  );

  return (
    <>
      <PageHeader
        eyebrow={t.campaigns.eyebrow}
        title={t.campaigns.title}
        description={t.campaigns.description}
        actions={
          <>
            <Button
              variant="outline"
              render={<Link href="/campaigns/audiences" />}
            >
              <Users data-icon="inline-start" />
              {t.campaigns.list.audiences}
            </Button>
            <Button render={<Link href="/campaigns/new" />}>
              <Plus data-icon="inline-start" />
              {t.campaigns.list.newCampaign}
            </Button>
          </>
        }
      />
      <div className="mt-8">
        <CampaignsList initial={initial} />
      </div>
    </>
  );
}
