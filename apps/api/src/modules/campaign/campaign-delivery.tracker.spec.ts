import { PgDialect } from 'drizzle-orm/pg-core';
import type { AppConfigService, Clock } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { CAMPAIGN_DELIVERY_STATUSES } from '../persistence/drizzle/schema';
import {
  CampaignDeliveryTracker,
  DELIVERY_STATUS_RANK,
  deliveryStatusRank,
  monotonicAdvanceGuard,
} from './campaign-delivery.tracker';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const TENANT = 't-1';

/**
 * A tx double that actually applies the monotonic rule, so the tests exercise
 * the CONTRACT (`sent` after `read` changes nothing) rather than the shape of
 * a query builder. The stored row is what the fake UPDATE guards against; the
 * real guard is SQL, and is asserted separately from the rank table below and
 * end-to-end in test/integration/campaign-send.integration-spec.ts.
 */
function makeHarness(
  options: {
    stored?: { deliveryStatus: string | null; id: string } | null;
    replyCandidate?: { id: string } | null;
  } = {},
) {
  const updates: Array<Record<string, unknown>> = [];
  const wheres: unknown[] = [];
  let stored =
    options.stored === undefined
      ? { id: 'r-1', deliveryStatus: null as string | null }
      : options.stored;
  const replyCandidate =
    options.replyCandidate === undefined
      ? { id: 'r-1' }
      : options.replyCandidate;
  let updateCount = 0;

  const tx = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: (condition: unknown) => {
            wheres.push(condition);
            return {
              returning: () => {
                updateCount += 1;
                // The first update call in `attributeReply` has no delivery
                // status involved; the harness only guards `apply`.
                const next = values.deliveryStatus as string | undefined;
                if (next === undefined) {
                  return Promise.resolve(replyCandidate ? [{ id: 'r-1' }] : []);
                }
                if (!stored) return Promise.resolve([]);
                const advance =
                  DELIVERY_STATUS_RANK[
                    next as keyof typeof DELIVERY_STATUS_RANK
                  ] > deliveryStatusRank(stored.deliveryStatus as never);
                if (!advance) return Promise.resolve([]);
                stored = { ...stored, deliveryStatus: next };
                return Promise.resolve([{ id: stored.id }]);
              },
            };
          },
        };
      },
    }),
    select: () => ({
      from: () => {
        const chain = {
          // `attributeReplyFromPhone` joins `customers` to resolve the
          // identity the webhook layer actually holds; `attributeReply` does
          // not. Both end at the same where/orderBy/limit.
          innerJoin: () => chain,
          where: () => ({
            orderBy: () => ({
              limit: () =>
                Promise.resolve(replyCandidate ? [replyCandidate] : []),
            }),
          }),
        };
        return chain;
      },
    }),
  };

  const tenantContext = {
    withTenantTx: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as TenantContextService;

  const config = {
    campaignReplyAttributionDays: 7,
  } as unknown as AppConfigService;

  const tracker = new CampaignDeliveryTracker(tenantContext, config, {
    now: () => NOW,
  } as unknown as Clock);

  return {
    tracker,
    updates,
    wheres,
    tenantContext,
    storedStatus: () => stored?.deliveryStatus ?? null,
    updateCount: () => updateCount,
  };
}

describe('delivery status ranking (F19 D5)', () => {
  it('ranks sent < delivered < read, with failed terminal above all of them', () => {
    expect(DELIVERY_STATUS_RANK.sent).toBeLessThan(
      DELIVERY_STATUS_RANK.delivered,
    );
    expect(DELIVERY_STATUS_RANK.delivered).toBeLessThan(
      DELIVERY_STATUS_RANK.read,
    );
    expect(DELIVERY_STATUS_RANK.failed).toBeGreaterThan(
      DELIVERY_STATUS_RANK.read,
    );
  });

  it('gives an unset delivery status rank 0, so any callback advances it', () => {
    expect(deliveryStatusRank(null)).toBe(0);
    for (const status of CAMPAIGN_DELIVERY_STATUSES) {
      expect(deliveryStatusRank(status)).toBeGreaterThan(0);
    }
  });

  it('has a rank for every status the column may hold', () => {
    expect(Object.keys(DELIVERY_STATUS_RANK).sort()).toEqual(
      [...CAMPAIGN_DELIVERY_STATUSES].sort(),
    );
  });

  it('builds the SQL guard from the rank table, with every literal a bound parameter', () => {
    const query = new PgDialect().sqlToQuery(monotonicAdvanceGuard('read'));
    // The incoming rank, plus one (status, rank) pair per state — all bound,
    // none interpolated into the SQL text.
    expect(query.params).toContain(DELIVERY_STATUS_RANK.read);
    for (const status of CAMPAIGN_DELIVERY_STATUSES) {
      expect(query.params).toContain(status);
      expect(query.params).toContain(DELIVERY_STATUS_RANK[status]);
      expect(query.sql).not.toContain(`'${status}'`);
    }
    expect(query.sql).toContain('CASE coalesce(');
  });
});

describe('CampaignDeliveryTracker.apply', () => {
  it('advances an untouched recipient on the first callback', async () => {
    const h = makeHarness();
    await expect(
      h.tracker.apply(TENANT, 'wamid.1', 'sent', null),
    ).resolves.toBe(true);
    expect(h.storedStatus()).toBe('sent');
  });

  it('walks sent -> delivered -> read', async () => {
    const h = makeHarness();
    await h.tracker.apply(TENANT, 'wamid.1', 'sent', null);
    await expect(
      h.tracker.apply(TENANT, 'wamid.1', 'delivered', null),
    ).resolves.toBe(true);
    await expect(
      h.tracker.apply(TENANT, 'wamid.1', 'read', null),
    ).resolves.toBe(true);
    expect(h.storedStatus()).toBe('read');
  });

  it('is a no-op for a replayed `sent` after a `read`', async () => {
    const h = makeHarness({ stored: { id: 'r-1', deliveryStatus: 'read' } });
    await expect(
      h.tracker.apply(TENANT, 'wamid.1', 'sent', null),
    ).resolves.toBe(false);
    expect(h.storedStatus()).toBe('read');
  });

  it('is a no-op for a repeated identical callback', async () => {
    const h = makeHarness({
      stored: { id: 'r-1', deliveryStatus: 'delivered' },
    });
    await expect(
      h.tracker.apply(TENANT, 'wamid.1', 'delivered', null),
    ).resolves.toBe(false);
  });

  it('treats failed as terminal — a later delivered/read does not erase it', async () => {
    const h = makeHarness({ stored: { id: 'r-1', deliveryStatus: 'failed' } });
    await expect(
      h.tracker.apply(TENANT, 'wamid.1', 'delivered', null),
    ).resolves.toBe(false);
    await expect(
      h.tracker.apply(TENANT, 'wamid.1', 'read', null),
    ).resolves.toBe(false);
    expect(h.storedStatus()).toBe('failed');
  });

  it('lets a failure land over a read', async () => {
    const h = makeHarness({ stored: { id: 'r-1', deliveryStatus: 'read' } });
    await expect(
      h.tracker.apply(TENANT, 'wamid.1', 'failed', 're-engagement blocked'),
    ).resolves.toBe(true);
    expect(h.updates.at(-1)).toMatchObject({
      deliveryError: 're-engagement blocked',
    });
  });

  it('is a silent no-op for a wamid that belongs to no campaign', async () => {
    const h = makeHarness({ stored: null });
    await expect(
      h.tracker.apply(TENANT, 'wamid.not-ours', 'delivered', null),
    ).resolves.toBe(false);
  });

  it('stamps delivered_at only on delivered and read_at only on read', async () => {
    const h = makeHarness();
    await h.tracker.apply(TENANT, 'wamid.1', 'delivered', null);
    expect(h.updates.at(-1)).toMatchObject({ deliveredAt: NOW });
    await h.tracker.apply(TENANT, 'wamid.1', 'read', null);
    expect(h.updates.at(-1)).toMatchObject({ readAt: NOW });
  });

  it('runs inside a tenant transaction, never an admin query', async () => {
    const h = makeHarness();
    await h.tracker.apply(TENANT, 'wamid.1', 'sent', null);
    expect(h.tenantContext.withTenantTx).toHaveBeenCalledWith(
      expect.any(Function),
      TENANT,
    );
  });
});

describe('CampaignDeliveryTracker.attributeReply', () => {
  it('credits the most recent uncredited campaign message in the window', async () => {
    const h = makeHarness();
    await expect(h.tracker.attributeReply(TENANT, 'c-1')).resolves.toBe(true);
    expect(h.updates.at(-1)).toMatchObject({ repliedAt: NOW });
  });

  it('is a no-op when the customer has no campaign message in the window', async () => {
    const h = makeHarness({ replyCandidate: null });
    await expect(h.tracker.attributeReply(TENANT, 'c-1')).resolves.toBe(false);
    expect(h.updateCount()).toBe(0);
  });

  it('runs inside a tenant transaction', async () => {
    const h = makeHarness();
    await h.tracker.attributeReply(TENANT, 'c-1');
    expect(h.tenantContext.withTenantTx).toHaveBeenCalledWith(
      expect.any(Function),
      TENANT,
    );
  });
});

// F19 (D5): the inbound-time entry point. The webhook layer holds a phone on
// a channel, not a customer id, and resolving one would mean a write on the
// hot inbound path for the sake of a metric.
describe('CampaignDeliveryTracker.attributeReplyFromPhone', () => {
  it('credits the most recent uncredited campaign message for that phone', async () => {
    const h = makeHarness();
    await expect(
      h.tracker.attributeReplyFromPhone(TENANT, '+971501234567', 'whatsapp'),
    ).resolves.toBe(true);
    expect(h.updates[0]).toMatchObject({ repliedAt: NOW });
  });

  it('is a no-op for a customer with no campaign message in the window', async () => {
    const h = makeHarness({ replyCandidate: null });
    await expect(
      h.tracker.attributeReplyFromPhone(TENANT, '+971501234567', 'whatsapp'),
    ).resolves.toBe(false);
    expect(h.updates).toHaveLength(0);
  });

  it('runs inside a tenant transaction, never an admin query (D7)', async () => {
    const h = makeHarness();
    await h.tracker.attributeReplyFromPhone(
      TENANT,
      '+971501234567',
      'whatsapp',
    );
    expect(h.tenantContext.withTenantTx).toHaveBeenCalledWith(
      expect.any(Function),
      TENANT,
    );
  });
});
