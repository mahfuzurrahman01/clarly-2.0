// Fake-tx harness in the CatalogService.spec.ts style: asserts the actual
// query shape (validation happens before the insert, a conflicting name maps
// to 409, deletion is blocked by a referencing campaign) rather than a
// mock's own canned return value — the F20 retroactive-review lesson this
// repo's testing.md now enforces.
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { SegmentService } from './segment.service';
import { SegmentDefinitionLimitError } from './segment-definition.schema';

const TENANT = '11111111-1111-1111-1111-111111111111';

const LABEL_DEFINITION = { kind: 'label', in: ['hot'] };

function segmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    tenantId: TENANT,
    name: 'Hot leads',
    description: null,
    definition: LABEL_DEFINITION,
    lastResolvedCount: null,
    lastResolvedAt: null,
    createdBy: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

interface Harness {
  tenantContext: TenantContextService;
  insertValues: Record<string, unknown>[];
  updateSets: Record<string, unknown>[];
  deletedIds: string[];
  campaignCount: number;
  insertError?: unknown;
}

function makeHarness(opts: {
  selectResult?: unknown[];
  insertResult?: unknown[];
  updateResult?: unknown[];
  campaignCount?: number;
  insertError?: unknown;
}): Harness {
  const insertValues: Record<string, unknown>[] = [];
  const updateSets: Record<string, unknown>[] = [];
  const deletedIds: string[] = [];
  const campaignCount = opts.campaignCount ?? 0;

  const makeTx = () => ({
    select: (selection?: Record<string, unknown>) => ({
      from: (table: { [key: string]: unknown }) => {
        // Distinguish the "count campaigns" query from the segment select by
        // the shape of the requested selection.
        const isCountQuery = !!selection && 'value' in selection;
        const chain = {
          where: () =>
            isCountQuery ? Promise.resolve([{ value: campaignCount }]) : chain,
          limit: () => Promise.resolve(opts.selectResult ?? []),
          then: (...args: unknown[]) =>
            (
              Promise.resolve(
                opts.selectResult ?? [],
              ) as unknown as Promise<unknown>
            ).then(...(args as [never, never])),
        };
        return chain;
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertValues.push(values);
        return {
          returning: () => {
            if (opts.insertError) return Promise.reject(opts.insertError);
            return Promise.resolve(opts.insertResult ?? [segmentRow()]);
          },
        };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updateSets.push(values);
        return {
          where: () => ({
            returning: () => {
              if (opts.insertError) return Promise.reject(opts.insertError);
              return Promise.resolve(opts.updateResult ?? [segmentRow()]);
            },
          }),
        };
      },
    }),
    delete: () => ({
      where: () => {
        deletedIds.push('deleted');
        return Promise.resolve([]);
      },
    }),
  });

  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => fn(makeTx()));
  const tenantContext = { withTenantTx } as unknown as TenantContextService;

  return {
    tenantContext,
    insertValues,
    updateSets,
    deletedIds,
    campaignCount,
  };
}

describe('SegmentService', () => {
  describe('create', () => {
    it('validates the definition before it ever reaches the insert', async () => {
      const harness = makeHarness({});
      const service = new SegmentService(harness.tenantContext);

      await expect(
        service.create(TENANT, { name: 'x', definition: { kind: 'bogus' } }),
      ).rejects.toThrow();
      expect(harness.insertValues).toHaveLength(0);
    });

    it('rejects an over-limit definition (D1 depth/leaf walker) before the insert', async () => {
      const harness = makeHarness({});
      const service = new SegmentService(harness.tenantContext);
      const overLimit = {
        kind: 'or',
        children: Array.from({ length: 3 }, () => ({
          kind: 'and',
          children: Array.from({ length: 8 }, () => ({
            kind: 'never_ordered',
          })),
        })),
      };

      await expect(
        service.create(TENANT, { name: 'x', definition: overLimit }),
      ).rejects.toThrow(SegmentDefinitionLimitError);
      expect(harness.insertValues).toHaveLength(0);
    });

    it('inserts a valid definition scoped to the tenant', async () => {
      const harness = makeHarness({ insertResult: [segmentRow()] });
      const service = new SegmentService(harness.tenantContext);

      const result = await service.create(TENANT, {
        name: 'Hot leads',
        definition: LABEL_DEFINITION,
      });

      expect(harness.insertValues[0]).toMatchObject({
        tenantId: TENANT,
        name: 'Hot leads',
        definition: LABEL_DEFINITION,
      });
      expect(result.name).toBe('Hot leads');
    });

    it('maps a unique-name violation to 409, not a raw DB error', async () => {
      const harness = makeHarness({
        insertError: { code: '23505' },
      });
      const service = new SegmentService(harness.tenantContext);

      await expect(
        service.create(TENANT, {
          name: 'Hot leads',
          definition: LABEL_DEFINITION,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('require', () => {
    it('404s when no row matches this tenant', async () => {
      const harness = makeHarness({ selectResult: [] });
      const service = new SegmentService(harness.tenantContext);

      await expect(service.require(TENANT, 'nope')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('re-validates the stored definition before returning it', async () => {
      const harness = makeHarness({
        selectResult: [segmentRow({ definition: { kind: 'bogus' } })],
      });
      const service = new SegmentService(harness.tenantContext);

      await expect(service.require(TENANT, 'id')).rejects.toThrow();
    });
  });

  describe('remove', () => {
    it('409s when a campaign references the segment, and does not delete', async () => {
      const harness = makeHarness({
        selectResult: [segmentRow()],
        campaignCount: 2,
      });
      const service = new SegmentService(harness.tenantContext);

      await expect(service.remove(TENANT, 'id')).rejects.toThrow(
        ConflictException,
      );
      expect(harness.deletedIds).toHaveLength(0);
    });

    it('deletes when no campaign references the segment', async () => {
      const harness = makeHarness({
        selectResult: [segmentRow()],
        campaignCount: 0,
      });
      const service = new SegmentService(harness.tenantContext);

      await service.remove(TENANT, 'id');
      expect(harness.deletedIds).toHaveLength(1);
    });
  });
});
