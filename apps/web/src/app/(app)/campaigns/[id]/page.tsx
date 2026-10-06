import { notFound } from "next/navigation";
import { getConsoleSession } from "@/lib/session";
import {
  getCampaign,
  getCampaignStats,
  listCampaignRecipients,
  listSegments,
  RECIPIENTS_PAGE_SIZE,
  type CampaignRecipient,
  type CampaignStats,
} from "@/lib/api/campaigns";
import { listTemplates } from "@/lib/api/templates";
import { ApiError } from "@/lib/api/client";
import { CampaignDetail } from "@/components/campaigns/campaign-detail";

export const dynamic = "force-dynamic";

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getConsoleSession();

  // 404 covers "does not exist" and "belongs to another tenant" alike — the
  // API makes them indistinguishable by design, and so does this page.
  let campaign;
  try {
    campaign = await getCampaign(id, session.token);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const launched = campaign.recipientCount > 0 || campaign.startedAt !== null;

  const [stats, recipients, segments, templates] = await Promise.all([
    getCampaignStats(id, session.token).catch(
      (): CampaignStats | null => null,
    ),
    launched
      ? listCampaignRecipients(
          id,
          { limit: RECIPIENTS_PAGE_SIZE, offset: 0 },
          session.token,
        ).catch((): CampaignRecipient[] => [])
      : Promise.resolve<CampaignRecipient[]>([]),
    listSegments(session.token),
    listTemplates(undefined, session.token),
  ]);

  return (
    <CampaignDetail
      initialCampaign={campaign}
      initialStats={stats}
      initialRecipients={recipients}
      segmentName={
        segments.find((segment) => segment.id === campaign.segmentId)?.name ??
        null
      }
      templateName={
        templates.find((template) => template.id === campaign.templateId)
          ?.name ?? null
      }
    />
  );
}
