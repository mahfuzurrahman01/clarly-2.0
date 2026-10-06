// ShipmentService.findDueForPoll against a real Postgres.
//
// The unit spec mocks this query, so it never caught that Postgres infers the
// bound `now` parameter in `$n - (interval * int)` as an `interval` — every
// sweep failed with "invalid input syntax for type interval" in the first
// deploy. Only a real database proves the parameter is typed correctly.
//
// Requires a real Postgres reachable at DATABASE_URL, connected as the
// non-superuser `app_user` role (see docs/decisions/F1-security.md). Run via
// `npm run test:integration` from apps/api.
import { Test } from '@nestjs/testing';
import { CoreModule } from '../../src/modules/core/core.module';
import { ShipmentService } from '../../src/modules/courier/shipment.service';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';

describe('ShipmentService.findDueForPoll (real Postgres)', () => {
  let persistence: PersistenceService;
  let shipments: ShipmentService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, PersistenceModule, TenantContextModule],
      providers: [ShipmentService],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    shipments = moduleRef.get(ShipmentService);

    await persistence.runMigrations();
  });

  afterAll(async () => {
    await persistence.onModuleDestroy();
  });

  it('runs the due-for-poll query without a parameter type error', async () => {
    // Any well-formed tenant id: the query runs under `withTenantTx` either
    // way, and an empty result still proves the parameters typed correctly.
    await expect(
      shipments.findDueForPoll(
        '00000000-0000-0000-0000-000000000001',
        new Date(),
        10,
      ),
    ).resolves.toEqual(expect.any(Array));
  });
});
