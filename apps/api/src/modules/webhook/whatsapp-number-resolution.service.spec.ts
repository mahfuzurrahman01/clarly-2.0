import type { PersistenceService } from '../persistence/persistence.service';
import { UnknownWhatsappNumberError } from './unknown-whatsapp-number.error';
import { WhatsappNumberResolutionService } from './whatsapp-number-resolution.service';

function makePersistence(rows: { tenantId: string }[]): {
  persistence: PersistenceService;
  runAdminQuery: jest.Mock;
} {
  const runAdminQuery = jest.fn((fn: (db: unknown) => unknown) => {
    // The real implementation passes a Drizzle db; the service only ever
    // calls .select().from().where().limit() on it, so a query-builder
    // stub matching that exact chain is enough to test the service's own
    // logic without a real database.
    const db = {
      select: () => db,
      from: () => db,
      where: () => db,
      limit: () => Promise.resolve(rows),
    };
    return fn(db);
  });

  return {
    persistence: { runAdminQuery } as unknown as PersistenceService,
    runAdminQuery,
  };
}

describe('WhatsappNumberResolutionService', () => {
  it('resolves a known phone_number_id to its tenant', async () => {
    const { persistence } = makePersistence([{ tenantId: 'tenant-a' }]);
    const service = new WhatsappNumberResolutionService(persistence);

    await expect(service.resolveTenantId('123456')).resolves.toBe('tenant-a');
  });

  it('throws UnknownWhatsappNumberError for an unrecognized phone_number_id', async () => {
    const { persistence } = makePersistence([]);
    const service = new WhatsappNumberResolutionService(persistence);

    await expect(
      service.resolveTenantId('does-not-exist'),
    ).rejects.toBeInstanceOf(UnknownWhatsappNumberError);
  });

  it('goes through the admin-query escape hatch, never withTenantTx (there is no tenant yet)', async () => {
    const { persistence, runAdminQuery } = makePersistence([
      { tenantId: 'tenant-a' },
    ]);
    const service = new WhatsappNumberResolutionService(persistence);

    await service.resolveTenantId('123456');

    expect(runAdminQuery).toHaveBeenCalledTimes(1);
  });
});
