import Link from "next/link";
import { notFound } from "next/navigation";
import { getConsoleSession } from "@/lib/session";
import { getCampaign, listSegments } from "@/lib/api/campaigns";
import { listTemplates } from "@/lib/api/templates";
import { listConnectedNumbers } from "@/lib/api/whatsapp-connect";
import { ApiError } from "@/lib/api/client";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { CampaignComposer } from "@/components/campaigns/campaign-composer";

export const dynamic = "force-dynamic";

export default async function EditCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();

  let campaign;
  try {
    campaign = await getCampaign(id, session.token);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  // `PUT /campaigns/:id` is draft-only and 409s otherwise. Saying so here
  // beats letting someone re-fill a form the API will refuse.
  if (campaign.status !== "draft") {
    return (
      <>
        <PageHeader
          eyebrow={t.campaigns.eyebrow}
          title={t.campaigns.compose.editLockedTitle}
        />
        <div className="mt-8 space-y-4 rounded-xl border border-border p-6">
          <p className="max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
            {t.campaigns.compose.editLockedBody}
          </p>
          <Button variant="outline" render={<Link href={`/campaigns/${id}`} />}>
            {t.campaigns.detail.back}
          </Button>
        </div>
      </>
    );
  }

  const [templates, numbers, segments] = await Promise.all([
    listTemplates(undefined, session.token),
    listConnectedNumbers(session.token),
    listSegments(session.token),
  ]);

  return (
    <>
      <PageHeader
        eyebrow={t.campaigns.eyebrow}
        title={t.campaigns.compose.editTitle}
      />
      <div className="mt-8">
        <CampaignComposer
          templates={templates}
          numbers={numbers}
          segments={segments}
          campaign={campaign}
        />
      </div>
    </>
  );
}
