// F19 (D5, D9): the stats endpoint is a PURE AGGREGATE over
// `campaign_recipients` — no denormalised counters that could drift. These
// cases pin the two things that follow from that:
//   - the numbers come from the recipient rows, not from `campaigns`
//     (`spent_usd` and the cap are the documented exceptions), and
//   - `delivered` counts `read` too, so `read > delivered` can never happen.
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { CampaignStatsService } from './campaign-stats.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CAMPAIGN = '44444444-4444-4444-4444-444444444444';

function harness(opts: {
  campaign?: Record<string, unknown> | null;
  totals?: Record<string, number>;
  reasons?: { reason: string | null; count: number }[];
  recipients?: Record<string, unknown>[];
}) {
  const campaignRow =
    opts.campaign === null
      ? null
      : {
          id: CAMPAIGN,
          status: 'completed',
          recipientCount: 10,
          spentUsd: 0.344,
          spendCapUsd: 50,
          estimatedCostUsd: 1,
          ...opts.campaign,
        };

  // The service issues, in order: the campaign row (limit 1), the totals
  // (one row, no limit), then the skip-reason groups.
  let selectCall = 0;

  const makeTx = () => ({
    select: () => {
      const call = selectCall++;
      return {
        from: () => ({
          where: () => {
            const results =
              call === 0
                ? campaignRow
                  ? [campaignRow]
                  : []
                : call === 1
                  ? [opts.totals ?? {}]
                  : (opts.reasons ?? []);
            const thenable = {
              limit: () => Promise.resolve(results),
              groupBy: () => Promise.resolve(results),
              orderBy: () => ({
                limit: () => ({
                  offset: () => Promise.resolve(opts.recipients ?? []),
                }),
              }),
              then: (...args: unknown[]) =>
                (Promise.resolve(results) as unknown as Promise<unknown>).then(
                  ...(args as [never, never]),
                ),
            };
            return thenable;
          },
        }),
      };
    },
  });

  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => fn(makeTx()));
  const service = new CampaignStatsService({
    withTenantTx,
  } as unknown as TenantContextService);

  return { service, withTenantTx };
}

describe('CampaignStatsService.forCampaign', () => {
  it('returns null for a campaign this tenant cannot see — the controller turns that into a 404', async () => {
    const h = harness({ campaign: null });
    await expect(h.service.forCampaign(TENANT, CAMPAIGN)).resolves.toBeNull();
  });

  it('reports every recipient state from the recipient rows', async () => {
    const h = harness({
      totals: {
        pending: 1,
        sending: 0,
        sent: 7,
        failed: 1,
        skipped: 1,
        delivered: 6,
        read: 3,
        replied: 2,
      },
    });

    const stats = await h.service.forCampaign(TENANT, CAMPAIGN);

    expect(stats).toMatchObject({
      campaignId: CAMPAIGN,
      status: 'completed',
      pending: 1,
      sent: 7,
      failed: 1,
      skipped: 1,
      delivered: 6,
      read: 3,
      replied: 2,
    });
  });

  it('carries the money from `campaigns`, which is the one place it is allowed to live', async () => {
    const h = harness({ totals: {} });
    const stats = await h.service.forCampaign(TENANT, CAMPAIGN);

    expect(stats).toMatchObject({
      spentUsd: 0.344,
      spendCapUsd: 50,
      estimatedCostUsd: 1,
      recipientCount: 10,
    });
  });

  it('breaks skips down by the reason that produced them — nothing is dropped without one', async () => {
    const h = harness({
      totals: { skipped: 3 },
      reasons: [
        { reason: 'opted_out', count: 2 },
        { reason: 'canceled', count: 1 },
      ],
    });

    const stats = await h.service.forCampaign(TENANT, CAMPAIGN);
    expect(stats!.skippedByReason).toEqual({ opted_out: 2, canceled: 1 });
  });

  it('labels a null reason rather than dropping the bucket', async () => {
    const h = harness({
      totals: { skipped: 1 },
      reasons: [{ reason: null, count: 1 }],
    });

    const stats = await h.service.forCampaign(TENANT, CAMPAIGN);
    expect(stats!.skippedByReason).toEqual({ unknown: 1 });
  });

  it('defaults every count to zero for a campaign with no recipients yet', async () => {
    const h = harness({ totals: {} });
    const stats = await h.service.forCampaign(TENANT, CAMPAIGN);

    expect(stats).toMatchObject({
      pending: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      delivered: 0,
      read: 0,
      replied: 0,
      skippedByReason: {},
    });
  });
});

describe('CampaignStatsService.listRecipients', () => {
  it('returns the snapshot rows the console paginates through', async () => {
    const h = harness({
      recipients: [
        { id: 'r1', customerId: 'c1', phone: '+971501234567', status: 'sent' },
      ],
    });

    await expect(
      h.service.listRecipients(TENANT, CAMPAIGN, { limit: 20, offset: 0 }),
    ).resolves.toEqual([
      { id: 'r1', customerId: 'c1', phone: '+971501234567', status: 'sent' },
    ]);
  });

  it('opens the query under the tenant context — D7 bans an admin query in this module', async () => {
    const h = harness({ recipients: [] });
    await h.service.listRecipients(TENANT, CAMPAIGN, {
      limit: 20,
      offset: 0,
      status: 'pending',
    });

    expect(h.withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT);
  });
});
