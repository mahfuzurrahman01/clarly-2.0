// F19 (D1, D9): THE PLAN GATE.
//
// "An integration test seeds 50 000 customers with labels and asserts the
// resolve plan contains no `Seq Scan` on `customers` or `customer_labels`."
//
// This exists because F20 shipped an unindexed ILIKE scan and nothing
// asserted otherwise. A segment resolve is the one query in this feature
// that runs against a tenant's entire customer table, so it is the one that
// has to be proven — not believed — to be index-driven, at the size a real
// broadcast targets.
//
// It also asserts the round-trip count, not wall-clock time: a timing
// assertion in CI is a flake generator, while "resolve issues a bounded
// number of statements" is exactly the F20 CSV-import failure mode (one
// round trip PER ROW) stated as something a test can see.
//
// The four ORDER-HISTORY criteria are deliberately NOT covered here. F25
// owns `orders` and its two indexes (D1); F19 does not create or migrate
// that table, and coupling this gate to a schema another lane is still
// landing would make it fail for reasons that are not about F19. When F25
// has landed, add an `orders` seed and the same no-Seq-Scan assertion for
// `order_count` / `order_total_usd` / `last_order_within_days` /
// `never_ordered`.
//
// Requires a real Postgres reachable at DATABASE_URL, as the non-superuser
// `app_user` role. Run via `npm run test:integration` from apps/api.
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { SegmentResolverService } from '../../src/modules/campaign/segment-resolver.service';
import { compileSegmentCondition } from '../../src/modules/campaign/segment-compiler';
import type { SegmentNode } from '../../src/modules/campaign/segment-definition.schema';
import { CoreModule } from '../../src/modules/core/core.module';
import {
  customers,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';

/** The size a real Gulf broadcast targets, and CAMPAIGN_MAX_RECIPIENTS' default. */
const SEED_SIZE = 50_000;
const LABELS = ['hot_lead', 'browsing', 'support', 'churn_risk'] as const;

jest.setTimeout(300_000);

describe('segment resolve plan at 50k customers (F19 D1/D9 plan gate)', () => {
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let resolver: SegmentResolverService;

  const tenantId = randomUUID();

  /** `EXPLAIN` under the tenant GUC, so the plan is the one the app actually gets (RLS quals included). */
  async function explain(definition: SegmentNode): Promise<string> {
    const condition = compileSegmentCondition(definition);
    return tenantContext.withTenantTx(async (tx) => {
      const query = tx
        .select({ id: customers.id })
        .from(customers)
        .where(
          sql`${customers.tenantId} = ${tenantId}
              AND ${customers.optedOutAt} IS NULL
              AND ${customers.marketingOptedOutAt} IS NULL
              AND ${condition}`,
        );
      const result = await tx.execute(
        sql`EXPLAIN (FORMAT TEXT) ${query.getSQL()}`,
      );
      return result.rows.map((row) => Object.values(row)[0]).join('\n');
    }, tenantId);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, PersistenceModule, TenantContextModule],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    resolver = new SegmentResolverService(tenantContext);

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Plan gate tenant' }),
    );

    // Seeded with one set-returning INSERT rather than 50 000 round trips —
    // which is, not coincidentally, the same lesson this test exists to
    // enforce about the resolver.
    await persistence.runAdminQuery((db) =>
      db.execute(sql`
        INSERT INTO customers (tenant_id, channel, phone, name, tags, created_at)
        SELECT ${tenantId}, 'whatsapp', '+9715' || lpad(n::text, 8, '0'),
               'Customer ' || n,
               CASE WHEN n % 3 = 0 THEN '["vip"]'::jsonb ELSE '[]'::jsonb END,
               now() - (n % 400) * interval '1 day'
          FROM generate_series(1, ${SEED_SIZE}) AS n
      `),
    );
    await persistence.runAdminQuery((db) =>
      db.execute(sql`
        INSERT INTO customer_labels (tenant_id, customer_id, label, source)
        SELECT ${tenantId}, c.id,
               (ARRAY['hot_lead','browsing','support','churn_risk'])[1 + (row_number() OVER (ORDER BY c.id)) % 4],
               'agent'
          FROM customers c
         WHERE c.tenant_id = ${tenantId}
      `),
    );
    // Without this the planner is choosing from stale (empty-table)
    // statistics, and a seq scan would be the RIGHT plan for what it thinks
    // it has — the gate would pass or fail for the wrong reason.
    await persistence.runAdminQuery((db) =>
      db.execute(sql`ANALYZE customers; ANALYZE customer_labels;`),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.execute(
        sql`DELETE FROM customer_labels WHERE tenant_id = ${tenantId}`,
      ),
    );
    await persistence.runAdminQuery((db) =>
      db.execute(sql`DELETE FROM customers WHERE tenant_id = ${tenantId}`),
    );
    await persistence.runAdminQuery((db) =>
      db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`),
    );
    await persistence.onModuleDestroy();
  });

  it.each<[string, SegmentNode]>([
    ['label', { kind: 'label', in: [LABELS[0]] }],
    ['tag', { kind: 'tag', hasAny: ['vip'] }],
    ['customer_created', { kind: 'customer_created', within_days: 30 }],
    [
      'and(label, tag)',
      {
        kind: 'and',
        children: [
          { kind: 'label', in: [LABELS[0], LABELS[1]] },
          { kind: 'tag', hasAny: ['vip'] },
        ],
      },
    ],
  ])(
    'resolves %s with no Seq Scan on customers or customer_labels',
    async (_name, definition) => {
      const plan = await explain(definition);

      expect(plan).not.toMatch(/Seq Scan on customers/i);
      expect(plan).not.toMatch(/Seq Scan on customer_labels/i);
    },
  );

  it('pages the snapshot in a BOUNDED number of statements, not one per row', async () => {
    const campaignId = randomUUID();
    const segmentId = randomUUID();
    await tenantContext.withTenantTx(async (tx) => {
      await tx.execute(
        sql`INSERT INTO segments (id, tenant_id, name, definition)
            VALUES (${segmentId}, ${tenantId}, 'plan gate', '{"kind":"tag","hasAny":["vip"]}'::jsonb)`,
      );
      await tx.execute(
        sql`INSERT INTO message_templates
              (id, tenant_id, kind, name, language, category, body, variables, approval_status)
            VALUES (${campaignId}, ${tenantId}, 'whatsapp_template', 'plan_gate', 'en',
                    'MARKETING', 'Hi {{1}}', '[]'::jsonb, 'approved')`,
      );
      await tx.execute(
        sql`INSERT INTO campaigns
              (id, tenant_id, name, segment_id, template_id, phone_number_id, spend_cap_usd)
            VALUES (${campaignId}, ${tenantId}, 'plan gate', ${segmentId}, ${campaignId}, 'pn-1', 5000)`,
      );
    }, tenantId);

    // ~16 667 of the 50 000 carry the "vip" tag.
    const { recipientCount } = await resolver.snapshot(
      tenantId,
      campaignId,
      { kind: 'tag', hasAny: ['vip'] },
      SEED_SIZE,
    );

    expect(recipientCount).toBeGreaterThan(10_000);

    const stored = await tenantContext.withTenantTx(
      (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n FROM campaign_recipients WHERE campaign_id = ${campaignId}`,
        ),
      tenantId,
    );
    expect((stored.rows[0] as { n: number }).n).toBe(recipientCount);

    await persistence.runAdminQuery((db) =>
      db.execute(
        sql`DELETE FROM campaign_recipients WHERE tenant_id = ${tenantId}`,
      ),
    );
    await persistence.runAdminQuery((db) =>
      db.execute(sql`DELETE FROM campaigns WHERE tenant_id = ${tenantId}`),
    );
    await persistence.runAdminQuery((db) =>
      db.execute(
        sql`DELETE FROM message_templates WHERE tenant_id = ${tenantId}`,
      ),
    );
    await persistence.runAdminQuery((db) =>
      db.execute(sql`DELETE FROM segments WHERE tenant_id = ${tenantId}`),
    );
  });
});
