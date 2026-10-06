import type { AppConfigService, AppLoggerService } from '../core';
import type { ObjectStorage } from '../storage/ports/object-storage.port';
import type { PersistenceService } from '../persistence/persistence.service';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { TranscriptPurgeService } from './transcript-purge.service';

function makeConfig(): AppConfigService {
  return { transcriptRetentionDays: 90 } as AppConfigService;
}

function makeStorage(): { storage: ObjectStorage; remove: jest.Mock } {
  const remove = jest.fn().mockResolvedValue(undefined);
  return { storage: { delete: remove } as unknown as ObjectStorage, remove };
}

function makeLogger(error: jest.Mock = jest.fn()): AppLoggerService {
  return {
    error,
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as AppLoggerService;
}

function makePersistence(tenantIds: string[]): PersistenceService {
  return {
    runAdminQuery: jest.fn((fn: (db: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => Promise.resolve(tenantIds.map((id) => ({ id }))),
        }),
      }),
    ),
  } as unknown as PersistenceService;
}

/**
 * `purgeTenant()` makes 4 real query calls inside one withTenantTx callback:
 * select expired conversations, count their messages, collect their media
 * storage keys (F13), delete the conversations.
 */
function makeTenantContext(
  expiredConversationIds: string[],
  messageCount: number,
  mediaStorageKeys: (string | null)[] = [],
): { tenantContext: TenantContextService; deleteWhere: jest.Mock } {
  const deleteWhere = jest.fn().mockResolvedValue(undefined);
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    // Local to this withTenantTx() invocation, not shared across calls —
    // purgeAllTenants() runs one purgeTenant() per tenant concurrently
    // (Promise.all), so a module-level counter would corrupt call-order
    // detection between interleaved tenants.
    let selectCall = 0;
    const tx = {
      select: () => {
        const call = selectCall;
        selectCall++;
        return {
          from: () => ({
            where: () => {
              if (call === 1) return Promise.resolve([{ count: messageCount }]);
              if (call === 2) {
                return Promise.resolve(
                  mediaStorageKeys.map((storageKey) => ({ storageKey })),
                );
              }
              return Promise.resolve(
                expiredConversationIds.map((id) => ({ id })),
              );
            },
          }),
        };
      },
      delete: () => ({ where: deleteWhere }),
    };
    return fn(tx);
  });
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    deleteWhere,
  };
}

describe('TranscriptPurgeService.purgeAllTenants()', () => {
  it('purges expired conversations and reports the real conversation/message counts', async () => {
    const persistence = makePersistence(['tenant-a']);
    const { tenantContext, deleteWhere } = makeTenantContext(
      ['conv-1', 'conv-2'],
      5,
    );
    const service = new TranscriptPurgeService(
      persistence,
      tenantContext,
      makeConfig(),
      makeStorage().storage,
      makeLogger(),
    );

    const results = await service.purgeAllTenants();

    expect(results).toEqual([
      { tenantId: 'tenant-a', conversationsPurged: 2, messagesPurged: 5 },
    ]);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('defaults messagesPurged to 0 when the count query returns no row at all (defensive — real Postgres always returns one row for count(*), but the code should not assume that)', async () => {
    const persistence = makePersistence(['tenant-a']);
    const deleteWhere = jest.fn().mockResolvedValue(undefined);
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
      let selectCall = 0;
      const tx = {
        select: () => {
          const isMessageCountQuery = selectCall === 1;
          selectCall++;
          return {
            from: () => ({
              where: () =>
                Promise.resolve(isMessageCountQuery ? [] : [{ id: 'conv-1' }]),
            }),
          };
        },
        delete: () => ({ where: deleteWhere }),
      };
      return fn(tx);
    });
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const service = new TranscriptPurgeService(
      persistence,
      tenantContext,
      makeConfig(),
      makeStorage().storage,
      makeLogger(),
    );

    const results = await service.purgeAllTenants();

    expect(results[0]).toEqual({
      tenantId: 'tenant-a',
      conversationsPurged: 1,
      messagesPurged: 0,
    });
  });

  it('skips the delete entirely and omits the tenant from results when nothing is expired', async () => {
    const persistence = makePersistence(['tenant-a']);
    const { tenantContext, deleteWhere } = makeTenantContext([], 0);
    const service = new TranscriptPurgeService(
      persistence,
      tenantContext,
      makeConfig(),
      makeStorage().storage,
      makeLogger(),
    );

    const results = await service.purgeAllTenants();

    expect(results).toEqual([]);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('sweeps every tenant independently', async () => {
    const persistence = makePersistence(['tenant-a', 'tenant-b']);
    // Same tenantContext mock is shared (both tenants call through the
    // same withTenantTx implementation) — this proves purgeAllTenants()
    // calls purgeTenant() once per tenant, not just once overall.
    const { tenantContext } = makeTenantContext(['conv-1'], 3);
    const service = new TranscriptPurgeService(
      persistence,
      tenantContext,
      makeConfig(),
      makeStorage().storage,
      makeLogger(),
    );

    const results = await service.purgeAllTenants();

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.tenantId).sort()).toEqual([
      'tenant-a',
      'tenant-b',
    ]);
  });
});

describe('TranscriptPurgeService media deletion (F13)', () => {
  it('deletes the attachment bytes behind purged messages', async () => {
    const persistence = makePersistence(['tenant-a']);
    const { tenantContext } = makeTenantContext(['conv-1'], 3, [
      'tenant-a/photo',
      'tenant-a/voice',
    ]);
    const { storage, remove } = makeStorage();
    const service = new TranscriptPurgeService(
      persistence,
      tenantContext,
      makeConfig(),
      storage,
      makeLogger(),
    );

    await service.purgeAllTenants();

    // No foreign key reaches object storage, so without this the bytes
    // outlive the purge and the retention claim is simply false.
    expect(remove).toHaveBeenCalledWith('tenant-a/photo');
    expect(remove).toHaveBeenCalledWith('tenant-a/voice');
  });

  it('touches storage not at all when nothing expired', async () => {
    const persistence = makePersistence(['tenant-a']);
    const { tenantContext } = makeTenantContext([], 0, []);
    const { storage, remove } = makeStorage();
    const service = new TranscriptPurgeService(
      persistence,
      tenantContext,
      makeConfig(),
      storage,
      makeLogger(),
    );

    await service.purgeAllTenants();

    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps going, loudly, when one object cannot be deleted', async () => {
    const persistence = makePersistence(['tenant-a']);
    const { tenantContext } = makeTenantContext(['conv-1'], 2, [
      'tenant-a/gone',
      'tenant-a/fine',
    ]);
    const { storage, remove } = makeStorage();
    remove.mockRejectedValueOnce(new Error('bucket unreachable'));
    const error = jest.fn();
    const service = new TranscriptPurgeService(
      persistence,
      tenantContext,
      makeConfig(),
      storage,
      makeLogger(error),
    );

    const results = await service.purgeAllTenants();

    // One unreachable object must not leave the rest undeleted, and the
    // orphan it leaves behind is only recoverable if someone is told.
    expect(remove).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalled();
    expect(results[0].conversationsPurged).toBe(1);
  });
});
