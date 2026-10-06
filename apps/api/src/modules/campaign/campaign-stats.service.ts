// F19 (D5): `GET /campaigns/:id/stats` and `/recipients`.
//
// A PURE AGGREGATE over `campaign_recipients`. There are deliberately no
// denormalised counters on `campaigns` that could drift — which is why exit
// criterion 3 ("per-campaign counts match what the webhook layer received")
// holds by construction: the campaign's numbers and the webhook layer's
// writes are the same rows.
//
// `spent_usd` is the one exception and it lives on `campaigns`, because it
// gates money and has to be transactional with the send rather than derived
// afterwards.
import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { campaignRecipients, campaigns } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';

export interface CampaignStats {
  campaignId: string;
  status: string;
  /** Snapshotted at launch. Zero until the campaign has launched. */
  recipientCount: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  skipped: number;
  delivered: number;
  read: number;
  replied: number;
  /** Every terminal skip, by the reason that produced it. Nothing is ever dropped without one. */
  skippedByReason: Record<string, number>;
  /** Actual accrued spend, incremented transactionally with each send. */
  spentUsd: number;
  spendCapUsd: number;
  /** Labelled "estimated" everywhere it surfaces — see campaign-pricing.ts. */
  estimatedCostUsd: number;
}

export interface CampaignRecipientSummary {
  id: string;
  customerId: string;
  phone: string;
  status: string;
  skipReason: string | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
  costUsd: number | null;
  attemptCount: number;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  repliedAt: Date | null;
}

const countWhere = (condition: ReturnType<typeof sql>) =>
  sql<number>`count(*) FILTER (WHERE ${condition})::int`;

@Injectable()
export class CampaignStatsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** Returns null when the campaign does not exist for this tenant — the controller turns that into a 404. */
  async forCampaign(
    tenantId: string,
    campaignId: string,
  ): Promise<CampaignStats | null> {
    return this.tenantContext.withTenantTx(async (tx) => {
      const campaignRows = await tx
        .select({
          id: campaigns.id,
          status: campaigns.status,
          recipientCount: campaigns.recipientCount,
          spentUsd: campaigns.spentUsd,
          spendCapUsd: campaigns.spendCapUsd,
          estimatedCostUsd: campaigns.estimatedCostUsd,
        })
        .from(campaigns)
        .where(
          and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, tenantId)),
        )
        .limit(1);

      const campaign = campaignRows[0];
      if (!campaign) return null;

      const scope = and(
        eq(campaignRecipients.tenantId, tenantId),
        eq(campaignRecipients.campaignId, campaignId),
      );

      // One pass over the campaign's slice of
      // campaign_recipients_campaign_status_idx.
      const [totals] = await tx
        .select({
          pending: countWhere(sql`${campaignRecipients.status} = 'pending'`),
          sending: countWhere(sql`${campaignRecipients.status} = 'sending'`),
          sent: countWhere(sql`${campaignRecipients.status} = 'sent'`),
          failed: countWhere(sql`${campaignRecipients.status} = 'failed'`),
          skipped: countWhere(sql`${campaignRecipients.status} = 'skipped'`),
          delivered: countWhere(
            sql`${campaignRecipients.deliveryStatus} IN ('delivered', 'read')`,
          ),
          read: countWhere(sql`${campaignRecipients.deliveryStatus} = 'read'`),
          replied: countWhere(sql`${campaignRecipients.repliedAt} IS NOT NULL`),
        })
        .from(campaignRecipients)
        .where(scope);

      const reasonRows = await tx
        .select({
          reason: campaignRecipients.skipReason,
          count: sql<number>`count(*)::int`,
        })
        .from(campaignRecipients)
        .where(and(scope, sql`${campaignRecipients.skipReason} IS NOT NULL`))
        .groupBy(campaignRecipients.skipReason);

      return {
        campaignId: campaign.id,
        status: campaign.status,
        recipientCount: campaign.recipientCount,
        pending: totals?.pending ?? 0,
        sending: totals?.sending ?? 0,
        sent: totals?.sent ?? 0,
        failed: totals?.failed ?? 0,
        skipped: totals?.skipped ?? 0,
        // A `read` receipt implies delivery even when the `delivered`
        // callback never arrived (Meta does drop them), so "delivered"
        // counts both — otherwise read > delivered, which reconciles with
        // nothing.
        delivered: totals?.delivered ?? 0,
        read: totals?.read ?? 0,
        replied: totals?.replied ?? 0,
        skippedByReason: Object.fromEntries(
          reasonRows.map((row) => [row.reason ?? 'unknown', row.count]),
        ),
        spentUsd: campaign.spentUsd,
        spendCapUsd: campaign.spendCapUsd,
        estimatedCostUsd: campaign.estimatedCostUsd,
      } satisfies CampaignStats;
    }, tenantId);
  }

  async listRecipients(
    tenantId: string,
    campaignId: string,
    options: { limit: number; offset: number; status?: string },
  ): Promise<CampaignRecipientSummary[]> {
    return this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            id: campaignRecipients.id,
            customerId: campaignRecipients.customerId,
            phone: campaignRecipients.phone,
            status: campaignRecipients.status,
            skipReason: campaignRecipients.skipReason,
            deliveryStatus: campaignRecipients.deliveryStatus,
            deliveryError: campaignRecipients.deliveryError,
            costUsd: campaignRecipients.costUsd,
            attemptCount: campaignRecipients.attemptCount,
            sentAt: campaignRecipients.sentAt,
            deliveredAt: campaignRecipients.deliveredAt,
            readAt: campaignRecipients.readAt,
            repliedAt: campaignRecipients.repliedAt,
          })
          .from(campaignRecipients)
          .where(
            and(
              eq(campaignRecipients.tenantId, tenantId),
              eq(campaignRecipients.campaignId, campaignId),
              options.status
                ? eq(campaignRecipients.status, options.status as never)
                : undefined,
            ),
          )
          .orderBy(desc(campaignRecipients.createdAt), campaignRecipients.id)
          .limit(options.limit)
          .offset(options.offset),
      tenantId,
    );
  }
}
