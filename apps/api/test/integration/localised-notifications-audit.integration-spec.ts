// QA 2026-10-05, proven against a real Postgres (migrations 0068 + 0069):
//
//   - a notification's params round-trip through the jsonb column, and a row
//     written before params existed reads back as {};
//   - acting on an entity retires ONLY that entity's notifications of the
//     named kinds, only in the acting tenant, and leaves an already-read row's
//     read time alone;
//   - an audit entry's detail key and params round-trip, and an entry without
//     them reads back null.
//
// The unit specs prove which call sites retire what; this proves the SQL does
// what they assume under RLS, as the non-superuser `app_user`.
//
// Run via `npm run test:integration` from apps/api against a LOCAL database.
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { CoreModule } from '../../src/modules/core/core.module';
import {
  auditLog,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { NotificationService } from '../../src/modules/notifications/notification.service';
import { markEntityNotificationsRead } from '../../src/modules/notifications/notification-resolution';
import { notificationContent } from '../../src/modules/notifications/notification-content';

describe('localised notifications and audit entries (QA 2026-10-05)', () => {
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let notifications: NotificationService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const orderId = randomUUID();
  const otherOrderId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, PersistenceModule, TenantContextModule],
      providers: [NotificationService],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    notifications = moduleRef.get(NotificationService);

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'QA localisation A' },
        { id: tenantB, name: 'QA localisation B' },
      ]),
    );
  });

  afterAll(async () => {
    for (const tenant of [tenantA, tenantB]) {
      await tenantContext.withTenantTx(
        (tx) =>
          tx.execute(
            sql`delete from notifications where tenant_id = ${tenant}`,
          ),
        tenant,
      );
      // audit_log has no DELETE policy by design (append-only); the tenant
      // delete's ON DELETE CASCADE removes this spec's entries.
      await persistence.runAdminQuery((db) =>
        db.execute(sql`delete from tenants where id = ${tenant}`),
      );
    }
    await persistence.onModuleDestroy();
  });

  function recordPendingApproval(tenantId: string, entityId: string) {
    return notifications.record({
      tenantId,
      ...notificationContent.orderPendingApproval({
        orderRef: 'ORD-AV96KJ',
        count: 1,
        total: '62.00',
        currency: 'SAR',
        customer: 'Riazul Islam',
      }),
      severity: 'warning',
      entityType: 'order',
      entityId,
      dedupKey: `order_pending_approval:${entityId}`,
    });
  }

  /** Read as the tenant: `notifications` is FORCE RLS, so a connection without the GUC sees nothing. */
  async function readAt(tenantId: string, entityId: string, kind: string) {
    const result = await tenantContext.withTenantTx(
      (tx) =>
        tx.execute(
          sql`select read_at from notifications
              where tenant_id = ${tenantId} and entity_id = ${entityId} and kind = ${kind}`,
        ),
      tenantId,
    );
    const row = result.rows[0] as { read_at: Date | string | null } | undefined;
    if (!row) throw new Error(`no ${kind} notification for ${entityId}`);
    return row.read_at === null ? null : new Date(row.read_at);
  }

  it('round-trips params, and reads a pre-0068 row (params null) as {}', async () => {
    await recordPendingApproval(tenantA, orderId);
    await tenantContext.withTenantTx(
      (tx) =>
        tx.execute(sql`
          insert into notifications (tenant_id, kind, severity, title, body, dedup_key)
          values (${tenantA}, 'trial_expired', 'warning', 'Your Clarly trial has ended', 'x', ${`legacy-${randomUUID()}`})
        `),
      tenantA,
    );

    const list = await notifications.list(tenantA, { limit: 50 });
    const approval = list.find((n) => n.kind === 'order_pending_approval');
    const legacy = list.find((n) => n.kind === 'trial_expired');

    expect(approval?.params).toEqual({
      orderRef: 'ORD-AV96KJ',
      count: 1,
      total: '62.00',
      currency: 'SAR',
      customer: 'Riazul Islam',
    });
    expect(approval?.title).toBe('Order ORD-AV96KJ is waiting for approval');
    expect(legacy?.params).toEqual({});
  });

  it('retires only the named kind about the named entity, in the acting tenant only', async () => {
    // Same entity id in another tenant, and a different kind about the same order.
    await recordPendingApproval(tenantB, orderId);
    await recordPendingApproval(tenantA, otherOrderId);
    await notifications.record({
      tenantId: tenantA,
      ...notificationContent.orderStorePushFailed({
        orderRef: 'ORD-AV96KJ',
        error: 'Salla 503',
      }),
      severity: 'critical',
      entityType: 'order',
      entityId: orderId,
      dedupKey: `order_store_push_failed:${orderId}`,
    });

    const marked = await tenantContext.withTenantTx(
      (tx) =>
        markEntityNotificationsRead(tx, {
          tenantId: tenantA,
          entityType: 'order',
          entityIds: [orderId],
          kinds: ['order_pending_approval'],
          readAt: new Date(),
        }),
      tenantA,
    );

    expect(marked).toBe(1);
    expect(
      await readAt(tenantA, orderId, 'order_pending_approval'),
    ).toBeInstanceOf(Date);
    expect(
      await readAt(tenantA, orderId, 'order_store_push_failed'),
    ).toBeNull();
    expect(
      await readAt(tenantA, otherOrderId, 'order_pending_approval'),
    ).toBeNull();
    expect(await readAt(tenantB, orderId, 'order_pending_approval')).toBeNull();
    expect(await notifications.unreadCount(tenantA)).toBe(3);
  });

  it('leaves an already-read notification at its original read time', async () => {
    const before = await readAt(tenantA, orderId, 'order_pending_approval');

    const marked = await tenantContext.withTenantTx(
      (tx) =>
        markEntityNotificationsRead(tx, {
          tenantId: tenantA,
          entityType: 'order',
          entityIds: [orderId],
          kinds: ['order_pending_approval'],
          readAt: new Date(Date.now() + 60_000),
        }),
      tenantA,
    );

    expect(marked).toBe(0);
    expect(await readAt(tenantA, orderId, 'order_pending_approval')).toEqual(
      before,
    );
  });

  it('round-trips an audit entry key and params, and returns null for an unkeyed entry', async () => {
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(auditLog).values([
          {
            tenantId: tenantA,
            actorUserId: 'user-1',
            actorRole: 'admin',
            method: 'POST',
            route: '/orders/:id/approve',
            targetId: orderId,
            statusCode: 200,
            outcome: 'success',
            detail: 'Approved order ORD-AV96KJ (62.00 SAR)',
            detailKey: 'order.approved',
            detailParams: {
              orderRef: 'ORD-AV96KJ',
              total: '62.00',
              currency: 'SAR',
            },
          },
          {
            tenantId: tenantA,
            actorUserId: 'user-1',
            actorRole: 'admin',
            method: 'POST',
            route: '/auth/login',
            targetId: null,
            statusCode: 201,
            outcome: 'success',
            detail: null,
          },
        ]),
      tenantA,
    );

    const rows = await tenantContext.withTenantTx(
      (tx) =>
        tx.execute(sql`
          select route, detail_key, detail_params from audit_log
          where tenant_id = ${tenantA} order by route
        `),
      tenantA,
    );

    expect(rows.rows).toEqual([
      { route: '/auth/login', detail_key: null, detail_params: null },
      {
        route: '/orders/:id/approve',
        detail_key: 'order.approved',
        detail_params: {
          orderRef: 'ORD-AV96KJ',
          total: '62.00',
          currency: 'SAR',
        },
      },
    ]);
  });
});
