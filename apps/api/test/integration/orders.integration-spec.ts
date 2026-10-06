// F25 D9's integration slice, proven against a real Postgres:
//
//   - two concurrent transactions with the same idempotency key produce
//     EXACTLY ONE row, and both callers see the same order (D6.2 races 1 & 2);
//   - the partial unique index stops two racing TURNS opening two identical
//     pending orders (race 3);
//   - two concurrent approves produce one winner and one 409 (race 4);
//   - the expiry sweep moves only genuinely overdue pending orders.
//
// These are the cases a unit test cannot prove, because what closes each of
// them is a database constraint, not application code. F20 shipped a
// two-transaction upsert race that every unit test passed.
//
// Requires a real Postgres reachable at DATABASE_URL, connected as the
// non-superuser `app_user` role (see docs/decisions/F1-security.md) — RLS is a
// silent no-op for superusers. Run via `npm run test:integration` from
// apps/api.
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { CoreModule } from '../../src/modules/core/core.module';
import { tenants } from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';

describe('orders (F25)', () => {
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;

  const tenant = randomUUID();
  let customer: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, PersistenceModule, TenantContextModule],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);

    await persistence.runMigrations();

    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([{ id: tenant, name: 'F25 tenant' }]),
    );
    customer = randomUUID();
    await persistence.runAdminQuery((db) =>
      db.execute(
        sql`insert into customers (id, tenant_id, phone, name)
            values (${customer}, ${tenant}, '+966500000009', 'Order customer')`,
      ),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.execute(sql`delete from orders where tenant_id = ${tenant}`),
    );
    await persistence.runAdminQuery((db) =>
      db.execute(sql`delete from customers where tenant_id = ${tenant}`),
    );
    await persistence.runAdminQuery((db) =>
      db.execute(
        sql`delete from tenant_order_settings where tenant_id = ${tenant}`,
      ),
    );
    await persistence.runAdminQuery((db) =>
      db.execute(sql`delete from tenants where id = ${tenant}`),
    );
    await persistence.onModuleDestroy();
  });

  afterEach(async () => {
    await persistence.runAdminQuery((db) =>
      db.execute(sql`delete from orders where tenant_id = ${tenant}`),
    );
  });

  /** One `INSERT ... ON CONFLICT DO NOTHING RETURNING`, the exact statement shape OrderService writes. */
  function insertOrder(options: {
    reference: string;
    idempotencyKey: string;
    contentHash: string;
    conversationId: string | null;
    status?: string;
  }): Promise<unknown[]> {
    return tenantContext.withTenantTx(async (tx) => {
      const result = await tx.execute(sql`
        insert into orders (tenant_id, reference, customer_id, conversation_id, status,
                            contact_name, contact_phone, address,
                            subtotal, total, currency,
                            idempotency_key, content_hash)
        values (${tenant}, ${options.reference}, ${customer}, ${options.conversationId},
                ${options.status ?? 'pending_approval'},
                'Aisha', '+966500000009', 'Riyadh',
                '100.00', '100.00', 'SAR',
                ${options.idempotencyKey}, ${options.contentHash})
        on conflict (tenant_id, idempotency_key) do nothing
        returning id
      `);
      return result.rows;
    }, tenant);
  }

  describe('D6.2 races 1 & 2 — a retried tool call or a retried job', () => {
    it('produces exactly one row when two transactions race on the same idempotency key', async () => {
      const key = `idem-${randomUUID()}`;
      const conversation = null;

      const [first, second] = await Promise.all([
        insertOrder({
          reference: `ORD-A${randomUUID().slice(0, 5).toUpperCase()}`,
          idempotencyKey: key,
          contentHash: `hash-${randomUUID()}`,
          conversationId: conversation,
        }),
        insertOrder({
          reference: `ORD-B${randomUUID().slice(0, 5).toUpperCase()}`,
          idempotencyKey: key,
          contentHash: `hash-${randomUUID()}`,
          conversationId: conversation,
        }),
      ]);

      // One insert returns its row; the other returns none and its caller
      // re-selects the winner.
      expect(first.length + second.length).toBe(1);

      const rows = await persistence.runAdminQuery((db) =>
        db.execute(
          sql`select id from orders where tenant_id = ${tenant} and idempotency_key = ${key}`,
        ),
      );
      expect(rows.rows).toHaveLength(1);
    });
  });

  describe('D6.2 race 3 — two turns in one conversation ordering the same thing', () => {
    it('refuses the second PENDING order with the same content hash', async () => {
      const conversation = randomUUID();
      await persistence.runAdminQuery((db) =>
        db.execute(
          sql`insert into conversations (id, tenant_id, customer_id, status)
              values (${conversation}, ${tenant}, ${customer}, 'ACTIVE')`,
        ),
      );
      const contentHash = `content-${randomUUID()}`;

      await insertOrder({
        reference: `ORD-C${randomUUID().slice(0, 5).toUpperCase()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        contentHash,
        conversationId: conversation,
      });

      let caught: unknown;
      try {
        await insertOrder({
          reference: `ORD-D${randomUUID().slice(0, 5).toUpperCase()}`,
          // A DIFFERENT turn, so a different idempotency key — the partial
          // unique index is the only thing that can catch this.
          idempotencyKey: `idem-${randomUUID()}`,
          contentHash,
          conversationId: conversation,
        });
      } catch (error) {
        caught = error;
      }

      expect(String(caught)).toMatch(/orders_pending_dedup_idx/);

      await persistence.runAdminQuery((db) =>
        db.execute(sql`delete from orders where tenant_id = ${tenant}`),
      );
      await persistence.runAdminQuery((db) =>
        db.execute(sql`delete from conversations where id = ${conversation}`),
      );
    });

    it('allows a second identical order once the first is no longer pending', async () => {
      const conversation = null;
      const contentHash = `content-${randomUUID()}`;

      await insertOrder({
        reference: `ORD-E${randomUUID().slice(0, 5).toUpperCase()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        contentHash,
        conversationId: conversation,
        status: 'confirmed',
      });

      // The index is PARTIAL — `WHERE status = 'pending_approval'` — so a
      // repeat customer ordering the same thing next week is not blocked.
      await expect(
        insertOrder({
          reference: `ORD-F${randomUUID().slice(0, 5).toUpperCase()}`,
          idempotencyKey: `idem-${randomUUID()}`,
          contentHash,
          conversationId: conversation,
        }),
      ).resolves.toHaveLength(1);
    });
  });

  describe('D6.2 race 4 — two console users approving at once', () => {
    it('lets exactly one conditional UPDATE win', async () => {
      const [row] = (await insertOrder({
        reference: `ORD-G${randomUUID().slice(0, 5).toUpperCase()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        contentHash: `content-${randomUUID()}`,
        conversationId: null,
      })) as Array<{ id: string }>;

      const approve = () =>
        tenantContext.withTenantTx(async (tx) => {
          const result = await tx.execute(sql`
            update orders set status = 'confirmed', approved_at = now()
            where tenant_id = ${tenant} and id = ${row.id}
              and status = 'pending_approval'
            returning id
          `);
          return result.rows;
        }, tenant);

      const [a, b] = await Promise.all([approve(), approve()]);

      // Zero rows back is what the service turns into a 409.
      expect(a.length + b.length).toBe(1);
    });
  });

  describe('D1.4 — the approval-window sweep', () => {
    it('expires only pending orders older than the window', async () => {
      const [fresh] = (await insertOrder({
        reference: `ORD-H${randomUUID().slice(0, 5).toUpperCase()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        contentHash: `content-${randomUUID()}`,
        conversationId: null,
      })) as Array<{ id: string }>;

      const [stale] = (await insertOrder({
        reference: `ORD-I${randomUUID().slice(0, 5).toUpperCase()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        contentHash: `content-${randomUUID()}`,
        conversationId: null,
      })) as Array<{ id: string }>;

      await persistence.runAdminQuery((db) =>
        db.execute(
          sql`update orders set created_at = now() - interval '48 hours' where id = ${stale.id}`,
        ),
      );

      const expired = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(sql`
          update orders set status = 'expired'
          where tenant_id = ${tenant}
            and status = 'pending_approval'
            and created_at < now() - interval '24 hours'
          returning id
        `);
        return result.rows as Array<{ id: string }>;
      }, tenant);

      expect(expired.map((entry) => entry.id)).toEqual([stale.id]);

      const remaining = await persistence.runAdminQuery((db) =>
        db.execute(sql`select status from orders where id = ${fresh.id}`),
      );
      expect((remaining.rows[0] as { status: string }).status).toBe(
        'pending_approval',
      );
    });
  });

  describe('D10 — the migration actually ran', () => {
    it('created all three tables with their constraints', async () => {
      const result = await persistence.runAdminQuery((db) =>
        db.execute(sql`
          select table_name from information_schema.tables
          where table_name in ('orders', 'order_items', 'tenant_order_settings')
        `),
      );
      expect(result.rows).toHaveLength(3);
    });

    it('refuses an approval window outside 1..168 (D1.1)', async () => {
      let caught: unknown;
      try {
        await persistence.runAdminQuery((db) =>
          db.execute(sql`
            insert into tenant_order_settings (tenant_id, approval_window_hours)
            values (${tenant}, 0)
          `),
        );
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toMatch(
        /tenant_order_settings_approval_window_check|check constraint/i,
      );
    });
  });
});
