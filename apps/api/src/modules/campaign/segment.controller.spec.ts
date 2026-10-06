import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { SegmentController } from './segment.controller';
import {
  createSegmentBodySchema,
  updateSegmentBodySchema,
} from './segment.dto.zod';
import type { SegmentResolverService } from './segment-resolver.service';
import type { SegmentService } from './segment.service';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const SEGMENT_ID = '22222222-2222-2222-2222-222222222222';

const auth = {
  tenantId: TENANT,
  userId: USER_ID,
  role: 'admin',
} as TenantAuthContext;
const noopAudit = { describe: jest.fn() };

function segmentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: SEGMENT_ID,
    tenantId: TENANT,
    name: 'Hot leads',
    description: null,
    definition: { kind: 'label', in: ['hot'] },
    lastResolvedCount: null,
    lastResolvedAt: null,
    createdBy: USER_ID,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function makeHarness() {
  const create = jest.fn().mockResolvedValue(segmentRecord());
  const list = jest.fn().mockResolvedValue([segmentRecord()]);
  const require = jest.fn().mockResolvedValue(segmentRecord());
  const update = jest
    .fn()
    .mockResolvedValue(segmentRecord({ name: 'Renamed' }));
  const remove = jest.fn().mockResolvedValue(undefined);
  const recordLastResolved = jest.fn().mockResolvedValue(undefined);
  const preview = jest.fn().mockResolvedValue({
    count: 5,
    resolvedAt: new Date('2026-09-01T00:00:00Z'),
  });

  const controller = new SegmentController(
    {
      create,
      list,
      require,
      update,
      remove,
      recordLastResolved,
    } as unknown as SegmentService,
    { preview } as unknown as SegmentResolverService,
  );

  return {
    controller,
    create,
    list,
    require,
    update,
    remove,
    preview,
    recordLastResolved,
  };
}

describe('SegmentController', () => {
  it('POST / creates a segment scoped to the calling tenant, attributing the calling user', async () => {
    const { controller, create } = makeHarness();

    await controller.create(
      auth,
      { name: 'Hot leads', definition: { kind: 'label', in: ['hot'] } },
      noopAudit,
    );

    expect(create).toHaveBeenCalledWith(TENANT, {
      name: 'Hot leads',
      description: null,
      definition: { kind: 'label', in: ['hot'] },
      createdBy: USER_ID,
    });
  });

  it('POST / rejects an invalid body (missing definition) with a validation error, before the service is called', () => {
    const pipe = new ZodValidationPipe(createSegmentBodySchema);
    expect(() => pipe.transform({ name: 'x' })).toThrow();
  });

  it('GET / lists segments for the calling tenant', async () => {
    const { controller, list } = makeHarness();
    await controller.list(auth);
    expect(list).toHaveBeenCalledWith(TENANT);
  });

  it('GET /:id returns the segment (404 is the service`s job via require())', async () => {
    const { controller, require } = makeHarness();
    await controller.get(auth, SEGMENT_ID);
    expect(require).toHaveBeenCalledWith(TENANT, SEGMENT_ID);
  });

  it('PUT /:id updates only the supplied fields', async () => {
    const { controller, update } = makeHarness();
    await controller.update(auth, SEGMENT_ID, { name: 'Renamed' }, noopAudit);
    expect(update).toHaveBeenCalledWith(TENANT, SEGMENT_ID, {
      name: 'Renamed',
    });
  });

  it('PUT /:id rejects an empty body', () => {
    const pipe = new ZodValidationPipe(updateSegmentBodySchema);
    expect(() => pipe.transform({})).toThrow();
  });

  it('DELETE /:id removes the segment', async () => {
    const { controller, remove } = makeHarness();
    await controller.remove(auth, SEGMENT_ID, noopAudit);
    expect(remove).toHaveBeenCalledWith(TENANT, SEGMENT_ID);
  });

  it('POST /:id/preview resolves the CURRENT stored definition and caches the count, without writing recipients', async () => {
    const { controller, require, preview, recordLastResolved } = makeHarness();

    const result = await controller.preview(auth, SEGMENT_ID);

    expect(require).toHaveBeenCalledWith(TENANT, SEGMENT_ID);
    expect(preview).toHaveBeenCalledWith(TENANT, {
      kind: 'label',
      in: ['hot'],
    });
    expect(recordLastResolved).toHaveBeenCalledWith(
      TENANT,
      SEGMENT_ID,
      5,
      expect.any(Date),
    );
    expect(result).toEqual({ count: 5, resolvedAt: expect.any(Date) });
  });
});
