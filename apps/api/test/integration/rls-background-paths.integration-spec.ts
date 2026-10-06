// Clarly 2.0: the paths that run with NO tenant — background sweeps and
// provider webhooks — against real Postgres, connected as the production-like
// role (`app_user`: NOSUPERUSER, NOBYPASSRLS; db-guard refuses anything else
// that is not local).
//
// Why this suite exists: these paths used to read FORCE-RLS tables through
// `runAdminQuery` with no `app.tenant_id`, which returns ZERO rows for this
// role. Every unit spec mocked the database, and the one integration spec
// asserted `expect.any(Array)`, so "found nothing" passed. Here every
// assertion is on seeded data that must be FOUND:
//
//   - a courier push resolves its tenant through `courier_routes`
//   - a store webhook resolves its tenant through `store_routes`
//   - deactivating either connection removes the route (fail closed)
//   - the shipment poll sweep reaches a due shipment and calls its courier
//   - routes:backfill (`rebuildRoutes`) restores routes for old connections
//
// Requires real Postgres. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { inArray, sql } from 'drizzle-orm';
import { CoreModule } from '../../src/modules/core/core.module';
import { CourierConnectionService } from '../../src/modules/courier/courier-connection.service';
import { CourierConnectorRegistry } from '../../src/modules/courier/courier-connector.registry';
import { DeliveryNotificationQueueService } from '../../src/modules/courier/delivery-notification.queue-service';
import { ShipmentPollService } from '../../src/modules/courier/shipment-poll.service';
import { ShipmentService } from '../../src/modules/courier/shipment.service';
import { NotificationService } from '../../src/modules/notifications/notification-record.module';
import {
  courierRoutes,
  storeRoutes,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { StoreConnectionService } from '../../src/modules/store/store-connection.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { TenantDirectoryService } from '../../src/modules/tenant-context/tenant-directory';
import { BspCredentialsEncryptionService } from '../../src/modules/whatsapp/bsp-credentials-encryption.service';

describe('no-tenant paths under FORCE RLS (Clarly 2.0)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let couriers: CourierConnectionService;
  let stores: StoreConnectionService;
  let poll: ShipmentPollService;
  const track = jest.fn();

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const accountRef = `ACC-${suffix}`;
  const storeId = `store-${suffix}`;
  const trackingNumber = `AWB-${suffix}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CoreModule, PersistenceModule, TenantContextModule],
      providers: [
        BspCredentialsEncryptionService,
        CourierConnectionService,
        StoreConnectionService,
        ShipmentService,
        ShipmentPollService,
        {
          provide: CourierConnectorRegistry,
          useValue: { forCourier: () => ({ track }) },
        },
        {
          provide: DeliveryNotificationQueueService,
          useValue: { enqueue: jest.fn() },
        },
        { provide: NotificationService, useValue: { record: jest.fn() } },
      ],
    }).compile();
    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    couriers = moduleRef.get(CourierConnectionService);
    stores = moduleRef.get(StoreConnectionService);
    poll = moduleRef.get(ShipmentPollService);
    await persistence.runMigrations();

    // The guard this whole suite depends on: if the connection could bypass
    // RLS, every assertion below would pass for the wrong reason.
    const [role] = await persistence
      .runAdminQuery((db) =>
        db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
          sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
        ),
      )
      .then((r) => r.rows);
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'RLS paths A' },
        { id: tenantB, name: 'RLS paths B' },
      ]),
    );
  });

  afterAll(async () => {
    // tenants → every child row by ON DELETE CASCADE (RI actions skip RLS).
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB])),
    );
    await moduleRef.close();
  });

  it('lists the seeded tenants without a tenant context', async () => {
    const ids = await moduleRef.get(TenantDirectoryService).listTenantIds();
    expect(ids).toEqual(expect.arrayContaining([tenantA, tenantB]));
  });

  describe('courier push routing', () => {
    let connectionId: string;

    it('finds the active connection of the right tenant from (courier, account_ref)', async () => {
      const created = await couriers.upsert({
        tenantId: tenantA,
        courier: 'aramex',
        accountRef,
        credentials: { username: 'u', password: 'p' },
        isActive: true,
        webhookSecret: 'whsec-a',
      });
      connectionId = created.id;

      const found = await couriers.findByRoutingKey('aramex', accountRef);
      expect(found).toMatchObject({
        id: connectionId,
        tenantId: tenantA,
        webhookSecret: 'whsec-a',
      });
      expect(
        await couriers.findByRoutingKey('aramex', 'ACC-unknown'),
      ).toBeNull();
    });

    it('stops routing the moment the connection is deactivated', async () => {
      await couriers.deactivate(tenantA, connectionId);
      expect(await couriers.findByRoutingKey('aramex', accountRef)).toBeNull();
      const routes = await persistence.runAdminQuery((db) =>
        db
          .select()
          .from(courierRoutes)
          .where(sql`${courierRoutes.connectionId} = ${connectionId}`),
      );
      expect(routes).toHaveLength(0);
    });

    it('routes:backfill restores the route of a connection that predates the table', async () => {
      // Reactivate, then wipe the route as if the connection were older than 0073.
      await couriers.upsert({
        tenantId: tenantA,
        courier: 'aramex',
        accountRef,
        credentials: { username: 'u', password: 'p' },
        isActive: true,
      });
      await persistence.runAdminQuery((db) =>
        db
          .delete(courierRoutes)
          .where(sql`${courierRoutes.accountRef} = ${accountRef}`),
      );
      expect(await couriers.findByRoutingKey('aramex', accountRef)).toBeNull();

      expect(await couriers.rebuildRoutes(tenantA)).toBe(1);
      expect(
        await couriers.findByRoutingKey('aramex', accountRef),
      ).toMatchObject({
        tenantId: tenantA,
      });
    });
  });

  describe('store webhook routing', () => {
    it('finds the active store connection, and the newest connect owns the store', async () => {
      const a = await stores.create({
        tenantId: tenantA,
        provider: 'salla',
        storeId,
        storeName: 'Shop A',
        accessToken: 'tok-a',
        webhookSecret: 'sec-a',
      });
      expect(
        await stores.findByProviderAndStoreId('salla', storeId),
      ).toMatchObject({
        id: a.id,
        tenantId: tenantA,
        webhookSecret: 'sec-a',
      });

      const b = await stores.create({
        tenantId: tenantB,
        provider: 'salla',
        storeId,
        storeName: 'Shop B',
        accessToken: 'tok-b',
        webhookSecret: 'sec-b',
      });
      expect(
        await stores.findByProviderAndStoreId('salla', storeId),
      ).toMatchObject({
        id: b.id,
        tenantId: tenantB,
      });

      // A disconnecting does not touch B's route.
      await stores.markDisconnected(tenantA, a.id);
      expect(
        await stores.findByProviderAndStoreId('salla', storeId),
      ).toMatchObject({
        tenantId: tenantB,
      });

      // B disconnecting closes the store: fail closed, never fall back silently.
      await stores.markDisconnected(tenantB, b.id);
      expect(
        await stores.findByProviderAndStoreId('salla', storeId),
      ).toBeNull();
      const routes = await persistence.runAdminQuery((db) =>
        db
          .select()
          .from(storeRoutes)
          .where(sql`${storeRoutes.storeId} = ${storeId}`),
      );
      expect(routes).toHaveLength(0);
    });
  });

  describe('shipment poll sweep', () => {
    it('reaches a due shipment of a tenant and asks its courier', async () => {
      const connection = await couriers.findByRoutingKey('aramex', accountRef);
      expect(connection).not.toBeNull();
      const customerId = randomUUID();
      const orderId = randomUUID();
      await tenantContext.withTenantTx(async (tx) => {
        await tx.execute(
          sql`insert into customers (id, tenant_id, phone, name) values (${customerId}, ${tenantA}, ${'+9665' + suffix.replace(/\D/g, '0').padEnd(8, '0')}, 'Poll customer')`,
        );
        await tx.execute(sql`
          insert into orders (id, tenant_id, reference, customer_id, status,
                              contact_name, contact_phone, address,
                              subtotal, total, currency,
                              idempotency_key, content_hash)
          values (${orderId}, ${tenantA}, ${'ORD-' + suffix}, ${customerId}, 'confirmed',
                  'Poll customer', '+966500000001', 'Riyadh',
                  '100.00', '100.00', 'SAR', ${'key-' + suffix}, ${'hash-' + suffix})
        `);
        await tx.execute(sql`
          insert into shipments (tenant_id, order_id, customer_id, courier_connection_id,
                                 courier, tracking_number, current_status)
          values (${tenantA}, ${orderId}, ${customerId}, ${connection!.id},
                  'aramex', ${trackingNumber}, 'in_transit')
        `);
      }, tenantA);

      track.mockResolvedValue([]);
      await poll.sweep(new Date());

      // The courier was asked about exactly our waybill, with our credentials.
      const calls = track.mock.calls as [Record<string, string>, string[]][];
      const ours = calls.find(([, numbers]) =>
        numbers.includes(trackingNumber),
      );
      expect(ours).toBeDefined();
      expect(ours![0]).toEqual({ username: 'u', password: 'p' });
    });
  });
});
