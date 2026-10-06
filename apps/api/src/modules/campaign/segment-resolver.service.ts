// F19 (D1): resolving a segment definition into actual customers.
//
// Two operations, deliberately different shapes:
//   - `preview()` is COUNT-only, re-run live every time the console asks —
//     never writes a row.
//   - `snapshot()` writes `campaign_recipients` once, at send launch, and is
//     never re-run for that campaign (D1: "the campaign is a snapshot").
//
// Both apply the SAME mandatory consent filter, which is NOT expressible in
// the segment grammar (`segment-definition.schema.ts` has no "consent"
// criterion) — `customers.opted_out_at IS NULL AND
// customers.marketing_opted_out_at IS NULL` is appended here, unconditionally,
// to every resolve.
//
// Pagination note (a deliberate, documented deviation from D1's "one
// INSERT...SELECT round trip per 1000 rows" ideal): this slice pages with a
// SELECT (ids + phones only, never full customer rows) followed by an INSERT
// of that page — two small round trips per 1000 customers, not one, but
// still nowhere near the F20 CSV-import failure mode of one round trip PER
// ROW. Collapsing to a single statement is left as follow-up (see HANDOFF).
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { campaignRecipients, customers } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { compileSegmentCondition } from './segment-compiler';
import type { SegmentNode } from './segment-definition.schema';

const PAGE_SIZE = 1000;

export class SegmentRecipientCapExceededError extends Error {
  constructor(
    public readonly resolvedCount: number,
    public readonly cap: number,
  ) {
    super(
      `Segment resolves to at least ${resolvedCount} recipients, exceeding the ${cap} cap. Narrow the segment or raise CAMPAIGN_MAX_RECIPIENTS.`,
    );
    this.name = 'SegmentRecipientCapExceededError';
  }
}

export interface SegmentPreviewResult {
  count: number;
  resolvedAt: Date;
}

export interface SegmentSnapshotResult {
  recipientCount: number;
}

/** The mandatory consent filter (D1's "consent is not a criterion — it is mandatory"), appended to every resolve, never expressible or removable in the grammar. */
export function mandatoryConsentFilter() {
  return and(
    isNull(customers.optedOutAt),
    isNull(customers.marketingOptedOutAt),
  )!;
}

@Injectable()
export class SegmentResolverService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** `POST /segments/:id/preview` — COUNT(*) under the compiled condition. Never writes a recipient row. */
  async preview(
    tenantId: string,
    definition: SegmentNode,
  ): Promise<SegmentPreviewResult> {
    const condition = compileSegmentCondition(definition);
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ value: sql<number>`count(*)::int` })
          .from(customers)
          .where(
            and(
              eq(customers.tenantId, tenantId),
              mandatoryConsentFilter(),
              condition,
            ),
          ),
      tenantId,
    );
    return { count: rows[0]?.value ?? 0, resolvedAt: new Date() };
  }

  /**
   * Snapshots the segment into `campaign_recipients` for one campaign.
   * Aborts the whole operation (no partial snapshot left behind) if the
   * resolved count would exceed `maxRecipients`.
   */
  async snapshot(
    tenantId: string,
    campaignId: string,
    definition: SegmentNode,
    maxRecipients: number,
  ): Promise<SegmentSnapshotResult> {
    const condition = compileSegmentCondition(definition);

    return this.tenantContext.withTenantTx(async (tx) => {
      let cursor: string | null = null;
      let total = 0;

      for (;;) {
        const page = await tx
          .select({ id: customers.id, phone: customers.phone })
          .from(customers)
          .where(
            and(
              eq(customers.tenantId, tenantId),
              mandatoryConsentFilter(),
              condition,
              cursor ? gt(customers.id, cursor) : undefined,
            ),
          )
          .orderBy(asc(customers.id))
          .limit(PAGE_SIZE);

        if (page.length === 0) break;

        total += page.length;
        if (total > maxRecipients) {
          // Throwing inside withTenantTx's callback rolls back the whole
          // transaction — every page inserted so far in THIS snapshot call
          // is undone. No partial snapshot is ever left behind (D1).
          throw new SegmentRecipientCapExceededError(total, maxRecipients);
        }

        await tx
          .insert(campaignRecipients)
          .values(
            page.map((row) => ({
              tenantId,
              campaignId,
              customerId: row.id,
              phone: row.phone,
            })),
          )
          .onConflictDoNothing({
            target: [
              campaignRecipients.campaignId,
              campaignRecipients.customerId,
            ],
          });

        cursor = page[page.length - 1].id;
        if (page.length < PAGE_SIZE) break;
      }

      return { recipientCount: total };
    }, tenantId);
  }
}
