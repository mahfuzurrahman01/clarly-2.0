import type { TenantContextService } from '../tenant-context/tenant-context.service';
import {
  SegmentRecipientCapExceededError,
  SegmentResolverService,
} from './segment-resolver.service';
import type { SegmentNode } from './segment-definition.schema';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CAMPAIGN = '22222222-2222-2222-2222-222222222222';
const DEFINITION: SegmentNode = { kind: 'label', in: ['hot'] };

function customerRow(id: string) {
  return { id, phone: `+1000000${id}` };
}

interface Harness {
  tenantContext: TenantContextService;
  insertBatches: Record<string, unknown>[][];
  selectWheres: unknown[];
}

/** Pages of customer ids returned by successive `select().from(customers)` calls, in order. */
function makeHarness(pages: string[][], countResult = 0): Harness {
  const insertBatches: Record<string, unknown>[][] = [];
  const selectWheres: unknown[] = [];
  const remainingPages = [...pages];

  const makeTx = () => ({
    select: (selection?: Record<string, unknown>) => ({
      from: () => {
        const isCountQuery = !!selection && 'value' in selection;
        const chain = {
          where: (where: unknown) => {
            selectWheres.push(where);
            if (isCountQuery) {
              return Promise.resolve([{ value: countResult }]);
            }
            return chain;
          },
          orderBy: () => chain,
          limit: () => {
            const ids = remainingPages.shift() ?? [];
            return Promise.resolve(ids.map(customerRow));
          },
        };
        return chain;
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>[]) => {
        insertBatches.push(values);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
  });

  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => fn(makeTx()));
  const tenantContext = { withTenantTx } as unknown as TenantContextService;

  return { tenantContext, insertBatches, selectWheres };
}

describe('SegmentResolverService.preview', () => {
  it('returns the compiled COUNT and a timestamp, and writes nothing', async () => {
    const harness = makeHarness([], 42);
    const service = new SegmentResolverService(harness.tenantContext);

    const result = await service.preview(TENANT, DEFINITION);

    expect(result.count).toBe(42);
    expect(result.resolvedAt).toBeInstanceOf(Date);
    expect(harness.insertBatches).toHaveLength(0);
  });
});

describe('SegmentResolverService.snapshot', () => {
  it('pages by keyset until a short page ends it, inserting one batch per page', async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => `id-${i}`);
    const harness = makeHarness([page1]);
    const service = new SegmentResolverService(harness.tenantContext);

    const result = await service.snapshot(TENANT, CAMPAIGN, DEFINITION, 100);

    expect(result.recipientCount).toBe(3);
    expect(harness.insertBatches).toHaveLength(1);
    expect(harness.insertBatches[0]).toHaveLength(3);
    expect(harness.insertBatches[0][0]).toMatchObject({
      tenantId: TENANT,
      campaignId: CAMPAIGN,
    });
  });

  it('stops when a page returns nothing, without inserting an empty batch', async () => {
    const harness = makeHarness([[]]);
    const service = new SegmentResolverService(harness.tenantContext);

    const result = await service.snapshot(TENANT, CAMPAIGN, DEFINITION, 100);

    expect(result.recipientCount).toBe(0);
    expect(harness.insertBatches).toHaveLength(0);
  });

  it('continues past a full (PAGE_SIZE) page into a second, shorter page', async () => {
    // The resolver always requests PAGE_SIZE (1000) per call and only stops
    // when a page comes back SHORTER than that — a full page must be
    // followed by another fetch.
    const fullPage = Array.from({ length: 1000 }, (_, i) => `full-${i}`);
    const shortPage = ['tail-0'];
    const harness = makeHarness([fullPage, shortPage]);
    const service = new SegmentResolverService(harness.tenantContext);

    const result = await service.snapshot(
      TENANT,
      CAMPAIGN,
      DEFINITION,
      fullPage.length + shortPage.length,
    );

    expect(result.recipientCount).toBe(fullPage.length + shortPage.length);
    expect(harness.insertBatches).toHaveLength(2);
  });

  it('aborts (throws) rather than exceeding the recipient cap, and never inserts the over-cap page', async () => {
    const page1 = Array.from({ length: 5 }, (_, i) => `id-${i}`);
    const harness = makeHarness([page1]);
    const service = new SegmentResolverService(harness.tenantContext);

    await expect(
      service.snapshot(TENANT, CAMPAIGN, DEFINITION, 3),
    ).rejects.toThrow(SegmentRecipientCapExceededError);
    expect(harness.insertBatches).toHaveLength(0);
  });
});
