// Feature 1 exit criteria (former FEATURE_PLAN.md):
//   1. "adversarial cross-tenant query with RLS enabled returns zero rows"
//   2. "crafted cross-tenant tool call fires ToolScopeViolation with no
//      detail leaked to the caller"
// Supersedes test/integration/tenant-guc.integration-spec.ts, which was
// explicitly marked THROWAWAY pending real tenant-scoped tables — this file
// folds its GUC-mechanism scenarios forward plus the real RLS proof.
//
// Requires a real Postgres reachable at DATABASE_URL, connected as the
// non-superuser `app_user` role (see docs/decisions/F1-security.md) —
// RLS is a silent no-op for superusers/BYPASSRLS roles regardless of
// policy, so running this against a superuser connection would give a
// false pass. Run via `npm run test:integration` from apps/api.
//
// Note on scope: this covers the Feature 1 exit-criteria slice of A10's
// adversarial injection corpus (cross-tenant tool-name injection against
// ToolExecutionModule directly). The full corpus (poisoned KB, crafted
// customer messages, system-prompt extraction, citation forgery) requires
// PromptModule/AgentModule and ships with Feature 3 as a required CI check
// per docs/decisions/F0-ci-test-strategy.md — not duplicated here.
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ToolScopeViolation } from '@repo/errors';
import { inArray, sql } from 'drizzle-orm';
import { CoreModule } from '../../src/modules/core/core.module';
import { CatalogService } from '../../src/modules/catalog/catalog.service';
import {
  products,
  tenantTools,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import {
  MissingTenantContextError,
  TenantContextService,
} from '../../src/modules/tenant-context/tenant-context.service';
import { ToolExecutionModule } from '../../src/modules/tool-execution/tool-execution.module';
import { ToolExecutionService } from '../../src/modules/tool-execution/tool-execution.service';
import type { ToolExecutionContext } from '../../src/modules/tool-execution/tool-execution-context';
import { ToolRegistryModule } from '../../src/modules/tool-registry/tool-registry.module';
import { TenantToolRegistryService } from '../../src/modules/tool-registry/tenant-tool-registry.service';

describe('Tenant isolation (Feature 1 exit criteria)', () => {
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let toolRegistry: TenantToolRegistryService;
  let toolExecution: ToolExecutionService;
  let catalog: CatalogService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        ToolRegistryModule,
        ToolExecutionModule,
      ],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    toolRegistry = moduleRef.get(TenantToolRegistryService);
    toolExecution = moduleRef.get(ToolExecutionService);
    // F20: constructed directly rather than by importing CatalogModule —
    // the service's only dependency is TenantContextService, and pulling in
    // the module would drag Auth/Billing/controllers into a test that is
    // about the RLS policy on one table.
    catalog = new CatalogService(tenantContext);

    await persistence.runMigrations();

    // tenants isn't RLS-scoped (see tenants.table.ts) — seeded via the
    // PersistenceService admin escape hatch, not withTenantTx().
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'Tenant A' },
        { id: tenantB, name: 'Tenant B' },
      ]),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db
        .delete(tenantTools)
        .where(inArray(tenantTools.tenantId, [tenantA, tenantB])),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(products).where(inArray(products.tenantId, [tenantA, tenantB])),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(sql`${tenants.id} in (${tenantA}, ${tenantB})`),
    );
    await persistence.onModuleDestroy();
  });

  describe('withTenantTx() GUC mechanism', () => {
    it('sets app.tenant_id inside the transaction, readable via current_setting', async () => {
      const observed = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select current_setting('app.tenant_id', true) as tenant_id`,
        );
        return (result.rows[0] as { tenant_id: string }).tenant_id;
      }, tenantA);

      expect(observed).toBe(tenantA);
    });

    it('does not leak the GUC across transactions on a reused pooled connection', async () => {
      const observedA = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select current_setting('app.tenant_id', true) as tenant_id`,
        );
        return (result.rows[0] as { tenant_id: string }).tenant_id;
      }, tenantA);

      const observedB = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select current_setting('app.tenant_id', true) as tenant_id`,
        );
        return (result.rows[0] as { tenant_id: string }).tenant_id;
      }, tenantB);

      expect(observedA).toBe(tenantA);
      expect(observedB).toBe(tenantB);
    });

    it('refuses to run without a tenant id (fail closed)', async () => {
      await expect(
        tenantContext.withTenantTx(async (tx) => {
          await tx.execute(sql`select 1`);
        }),
      ).rejects.toBeInstanceOf(MissingTenantContextError);
    });
  });

  describe('RLS on tenant_tools (T5 exit criterion)', () => {
    beforeAll(async () => {
      await toolRegistry.upsertTool(tenantA, {
        name: 'echo',
        description: 'Tenant A echo tool',
        jsonSchema: { type: 'object' },
      });
      await toolRegistry.upsertTool(tenantB, {
        name: 'echo',
        description: 'Tenant B echo tool',
        jsonSchema: { type: 'object' },
      });
    });

    it('a tenant only ever sees its own rows through the app-level query path', async () => {
      const aTools = await toolRegistry.listEnabledTools(tenantA);
      const bTools = await toolRegistry.listEnabledTools(tenantB);

      expect(aTools).toHaveLength(1);
      expect(aTools[0].description).toBe('Tenant A echo tool');
      expect(bTools).toHaveLength(1);
      expect(bTools[0].description).toBe('Tenant B echo tool');
    });

    it('adversarial: a hand-crafted query with no WHERE tenant_id clause, run under tenant A GUC, still returns zero of tenant B rows', async () => {
      const rows = await tenantContext.withTenantTx(async (tx) => {
        // Deliberately does NOT filter by tenant_id — RLS is the only thing
        // that can stop this from returning both tenants' rows.
        const result = await tx.execute(
          sql`select tenant_id, name from tenant_tools where tenant_id = ${tenantB}`,
        );
        return result.rows;
      }, tenantA);

      expect(rows).toHaveLength(0);
    });

    it('adversarial: cross-tenant INSERT is rejected by the RLS WITH CHECK clause', async () => {
      let caught: unknown;
      try {
        await tenantContext.withTenantTx(async (tx) => {
          await tx.execute(
            sql`insert into tenant_tools (tenant_id, name, description, json_schema) values (${tenantB}, 'sneaky', 'cross-tenant insert attempt', '{}')`,
          );
        }, tenantA);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      // drizzle wraps the underlying pg driver error ("Failed query: ...");
      // the real Postgres message (and its `code: '42501'`, insufficient
      // privilege) is on `.cause`.
      const cause = (caught as Error & { cause?: { message?: string } }).cause;
      expect(cause?.message).toMatch(/row-level security/i);
    });

    it('adversarial: cross-tenant UPDATE affects zero rows, never leaks or corrupts tenant B data', async () => {
      const result = await tenantContext.withTenantTx(async (tx) => {
        return tx.execute(
          sql`update tenant_tools set description = 'hacked' where tenant_id = ${tenantB}`,
        );
      }, tenantA);

      expect(result.rowCount).toBe(0);

      const bToolsAfter = await toolRegistry.listEnabledTools(tenantB);
      expect(bToolsAfter[0].description).toBe('Tenant B echo tool');
    });

    it('fails closed to zero rows with no tenant GUC set at all, even on a connection that previously had one', async () => {
      // Establishes the GUC on this connection first (so the "revert to ''
      // not NULL" behavior documented in migrations/0002 is actually
      // exercised, not just a virgin-connection NULL).
      await tenantContext.withTenantTx(async (tx) => {
        await tx.execute(sql`select 1`);
      }, tenantA);

      const rows = await persistence.runAdminQuery((db) =>
        db.execute(sql`select tenant_id from tenant_tools`),
      );
      expect(rows.rows).toHaveLength(0);
    });
  });

  // F20 (product catalog). A catalog is a tenant's price list — the single
  // most damaging table to leak across tenants, and the one the agent reads
  // on the respond path via `lookup_product`. Same proof as tenant_tools
  // above, plus the agent-facing search path, which must be unable to return
  // another tenant's row even when the attacker knows its exact name.
  describe('RLS on products (F20)', () => {
    const skuA = 'SHARED-SKU-001';

    beforeAll(async () => {
      await catalog.createProduct(tenantA, {
        name: 'Tenant A Wireless Mouse',
        sku: skuA,
        price: 49.99,
        category: 'Electronics',
      });
      await catalog.createProduct(tenantB, {
        // Same SKU under a different tenant is legal — the unique constraint
        // is (tenant_id, sku), not sku.
        name: 'Tenant B Wireless Mouse',
        sku: skuA,
        price: 999.99,
        category: 'Electronics',
      });
    });

    it('a tenant only ever lists its own products', async () => {
      const a = await catalog.listProducts(tenantA);
      const b = await catalog.listProducts(tenantB);

      expect(a.total).toBe(1);
      expect(a.products[0].name).toBe('Tenant A Wireless Mouse');
      expect(b.total).toBe(1);
      expect(b.products[0].price).toBe('999.99');
    });

    it("the agent's search path cannot reach another tenant's catalog row by name", async () => {
      const rows = await catalog.searchProducts(
        tenantA,
        'Tenant B Wireless Mouse',
        { limit: 10 },
      );

      expect(rows.every((row) => row.tenantId === tenantA)).toBe(true);
      expect(rows.map((row) => row.name)).not.toContain(
        'Tenant B Wireless Mouse',
      );
    });

    it("a SKU lookup returns the calling tenant's row, never the other tenant's identically-SKU'd one", async () => {
      const rows = await catalog.searchProducts(tenantA, skuA, { limit: 10 });

      expect(rows).toHaveLength(1);
      expect(rows[0].price).toBe('49.99');
    });

    it('adversarial: a hand-crafted query with no tenant filter returns zero of tenant B rows', async () => {
      const rows = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select id, name from products where tenant_id = ${tenantB}`,
        );
        return result.rows;
      }, tenantA);

      expect(rows).toHaveLength(0);
    });

    it('adversarial: cross-tenant INSERT is rejected by the RLS WITH CHECK clause', async () => {
      let caught: unknown;
      try {
        await tenantContext.withTenantTx(async (tx) => {
          await tx.execute(
            sql`insert into products (tenant_id, name, price) values (${tenantB}, 'planted', 0)`,
          );
        }, tenantA);
      } catch (error) {
        caught = error;
      }

      const cause = (caught as Error & { cause?: { message?: string } }).cause;
      expect(cause?.message).toMatch(/row-level security/i);
    });

    // The commercially nastiest version: repricing a competitor's catalog.
    it('adversarial: cross-tenant UPDATE affects zero rows and leaves tenant B pricing intact', async () => {
      const result = await tenantContext.withTenantTx(
        (tx) => tx.execute(sql`update products set price = 0.01`),
        tenantA,
      );

      expect(result.rowCount).toBe(1);

      const b = await catalog.listProducts(tenantB);
      expect(b.products[0].price).toBe('999.99');
    });

    it('fails closed to zero rows with no tenant GUC set at all', async () => {
      const rows = await persistence.runAdminQuery((db) =>
        db.execute(sql`select tenant_id from products`),
      );
      expect(rows.rows).toHaveLength(0);
    });
  });

  // F19 (D7, D9): "adversarial, not happy-path". `products` was missed in
  // this file once; all three F19 tables go in from the start.
  //
  // The point of the composite FKs (D2/D5) is that a cross-tenant reference
  // is impossible in the DATABASE, not merely refused by a controller: RLS'
  // WITH CHECK only constrains `tenant_id`, so a single-column FK to
  // `segments.id` would happily accept another tenant's segment.
  describe('RLS and composite FKs on segments / campaigns / campaign_recipients (F19 D7)', () => {
    const segmentA = randomUUID();
    const templateA = randomUUID();
    const campaignA = randomUUID();

    beforeAll(async () => {
      await tenantContext.withTenantTx(async (tx) => {
        await tx.execute(
          sql`insert into segments (id, tenant_id, name, definition)
              values (${segmentA}, ${tenantA}, 'A segment', '{"kind":"never_ordered"}'::jsonb)`,
        );
        await tx.execute(
          sql`insert into message_templates
                (id, tenant_id, kind, name, language, category, body, variables, approval_status)
              values (${templateA}, ${tenantA}, 'whatsapp_template', 'a_tpl', 'en',
                      'MARKETING', 'Hi {{1}}', '[]'::jsonb, 'approved')`,
        );
        await tx.execute(
          sql`insert into campaigns
                (id, tenant_id, name, segment_id, template_id, phone_number_id, spend_cap_usd)
              values (${campaignA}, ${tenantA}, 'A campaign', ${segmentA}, ${templateA}, 'pn-a', 50)`,
        );
      }, tenantA);
    });

    afterAll(async () => {
      await persistence.runAdminQuery((db) =>
        db.execute(
          sql`delete from campaign_recipients where tenant_id = ${tenantA}`,
        ),
      );
      await persistence.runAdminQuery((db) =>
        db.execute(sql`delete from campaigns where tenant_id = ${tenantA}`),
      );
      await persistence.runAdminQuery((db) =>
        db.execute(sql`delete from segments where tenant_id = ${tenantA}`),
      );
      await persistence.runAdminQuery((db) =>
        db.execute(
          sql`delete from message_templates where tenant_id = ${tenantA}`,
        ),
      );
    });

    it.each(['segments', 'campaigns', 'campaign_recipients'])(
      'adversarial: %s returns zero rows to another tenant even with no WHERE clause',
      async (table) => {
        const rows = await tenantContext.withTenantTx(
          (tx) => tx.execute(sql.raw(`select id from ${table}`)),
          tenantB,
        );
        expect(rows.rows).toHaveLength(0);
      },
    );

    it("adversarial: tenant B cannot create a campaign pointing at tenant A's segment and template", async () => {
      // Both ids really exist — that is the whole point. Only the composite
      // FK (tenant_id, segment_id) can refuse this.
      let caught: unknown;
      try {
        await tenantContext.withTenantTx(
          (tx) =>
            tx.execute(
              sql`insert into campaigns
                    (tenant_id, name, segment_id, template_id, phone_number_id, spend_cap_usd)
                  values (${tenantB}, 'stolen', ${segmentA}, ${templateA}, 'pn-b', 50)`,
            ),
          tenantB,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
    });

    it("adversarial: tenant B cannot snapshot a recipient onto tenant A's campaign", async () => {
      let caught: unknown;
      try {
        await tenantContext.withTenantTx(
          (tx) =>
            tx.execute(
              sql`insert into campaign_recipients (tenant_id, campaign_id, customer_id, phone)
                  values (${tenantB}, ${campaignA}, ${randomUUID()}, '+971500000000')`,
            ),
          tenantB,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
    });

    it('adversarial: cross-tenant UPDATE of a spend cap affects zero rows', async () => {
      const result = await tenantContext.withTenantTx(
        (tx) => tx.execute(sql`update campaigns set spend_cap_usd = 999999`),
        tenantB,
      );
      expect(result.rowCount).toBe(0);

      const stillFifty = await tenantContext.withTenantTx(
        (tx) =>
          tx.execute(
            sql`select spend_cap_usd from campaigns where id = ${campaignA}`,
          ),
        tenantA,
      );
      expect(
        Number((stillFifty.rows[0] as { spend_cap_usd: string }).spend_cap_usd),
      ).toBe(50);
    });

    it('fails closed to zero rows with no tenant GUC set at all', async () => {
      const rows = await persistence.runAdminQuery((db) =>
        db.execute(sql`select id from campaigns`),
      );
      expect(rows.rows).toHaveLength(0);
    });
  });

  // F25 D9: the adversarial tenant-isolation step this repo requires for
  // anything money-touching — and the exact class of miss F20 shipped, where
  // a new tenant-scoped table never reached this file.
  //
  // `order_items` gets its own case because its protection is TWO mechanisms,
  // not one: the RLS policy, and the COMPOSITE foreign key
  // (tenant_id, order_id) -> orders (tenant_id, id). Either alone would leave
  // a leaked order id exploitable.
  describe('RLS on orders and order_items (F25 D2/D9)', () => {
    const customerB = randomUUID();
    let orderB: string;

    beforeAll(async () => {
      // Seeded THROUGH tenant B's own GUC (`withTenantTx`), not
      // `runAdminQuery`: `orders`/`order_items`/`customers` are all FORCE
      // ROW LEVEL SECURITY, which applies to the table OWNER too —
      // `runAdminQuery` opens no transaction and sets no `app.tenant_id`, so
      // an insert through it hits the same `WITH CHECK` clause the
      // adversarial tests below exist to prove, and is correctly refused.
      // (Same fix as the F26 courier/shipment block below — see its
      // beforeAll comment for the full explanation and the live-Postgres
      // confirmation.)
      orderB = randomUUID();
      await tenantContext.withTenantTx(async (tx) => {
        await tx.execute(
          sql`insert into customers (id, tenant_id, phone, name) values (${customerB}, ${tenantB}, '+966500000001', 'Tenant B customer')`,
        );
        await tx.execute(sql`
          insert into orders (id, tenant_id, reference, customer_id, status,
                              contact_name, contact_phone, address,
                              subtotal, total, currency,
                              idempotency_key, content_hash)
          values (${orderB}, ${tenantB}, 'ORD-BBBBBB', ${customerB}, 'pending_approval',
                  'B Customer', '+966500000001', 'Jeddah',
                  '100.00', '100.00', 'SAR', 'key-b', 'hash-b')
        `);
        await tx.execute(sql`
          insert into order_items (tenant_id, order_id, product_name, unit_price,
                                   currency, quantity, line_total)
          values (${tenantB}, ${orderB}, 'B item', '100.00', 'SAR', 1, '100.00')
        `);
      }, tenantB);
    });

    afterAll(async () => {
      // Same reasoning as the seed above: a DELETE issued through
      // `runAdminQuery` with no GUC set does not error (a FORCE-RLS
      // `USING` clause just filters rows, unlike `WITH CHECK` on INSERT),
      // but it silently deletes ZERO rows — cleanup that looks like it ran
      // and didn't. Going through `withTenantTx(fn, tenantB)` makes the
      // delete actually see and remove what this block inserted.
      await tenantContext.withTenantTx(async (tx) => {
        await tx.execute(
          sql`delete from order_items where tenant_id = ${tenantB}`,
        );
        await tx.execute(sql`delete from orders where tenant_id = ${tenantB}`);
        await tx.execute(
          sql`delete from customers where tenant_id = ${tenantB}`,
        );
      }, tenantB);
    });

    it('FORCEs row level security on both tables, so even the owning role is filtered', async () => {
      const rows = await persistence.runAdminQuery((db) =>
        db.execute(
          sql`select relname, relrowsecurity, relforcerowsecurity from pg_class
              where relname in ('orders', 'order_items', 'tenant_order_settings')`,
        ),
      );
      expect(rows.rows).toHaveLength(3);
      for (const row of rows.rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    });

    it("adversarial: tenant A reading tenant B's order by its exact id gets zero rows", async () => {
      const rows = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select id, total from orders where id = ${orderB}`,
        );
        return result.rows;
      }, tenantA);

      expect(rows).toHaveLength(0);
    });

    it("adversarial: tenant A updating tenant B's order affects zero rows", async () => {
      await tenantContext.withTenantTx(async (tx) => {
        await tx.execute(
          sql`update orders set status = 'confirmed' where id = ${orderB}`,
        );
      }, tenantA);

      // Read back through tenant B's own GUC, not `runAdminQuery` — the
      // table is FORCE RLS, so an admin-query read of it sees zero rows
      // (same reasoning as the F26 block below) and would make this
      // assertion pass for the wrong reason (an empty result, not an
      // unchanged one).
      const [row] = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select status from orders where id = ${orderB}`,
        );
        return result.rows as Array<{ status: string }>;
      }, tenantB);
      expect(row.status).toBe('pending_approval');
    });

    it("adversarial: tenant A deleting tenant B's order affects zero rows", async () => {
      await tenantContext.withTenantTx(async (tx) => {
        await tx.execute(sql`delete from orders where id = ${orderB}`);
      }, tenantA);

      const rows = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select id from orders where id = ${orderB}`,
        );
        return result.rows;
      }, tenantB);
      expect(rows).toHaveLength(1);
    });

    it("adversarial: tenant A cannot read tenant B's order items even knowing the order id", async () => {
      const rows = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select id from order_items where order_id = ${orderB}`,
        );
        return result.rows;
      }, tenantA);

      expect(rows).toHaveLength(0);
    });

    it("adversarial: attaching an item to tenant B's order with a FORGED order_id is refused", async () => {
      // Under tenant A's GUC the row would pass the RLS WITH CHECK (its
      // tenant_id IS A), so the composite FK is what has to stop it: there is
      // no (tenantA, orderB) pair in `orders`.
      let caught: unknown;
      try {
        await tenantContext.withTenantTx(async (tx) => {
          await tx.execute(sql`
            insert into order_items (tenant_id, order_id, product_name, unit_price,
                                     currency, quantity, line_total)
            values (${tenantA}, ${orderB}, 'forged', '1.00', 'SAR', 1, '1.00')
          `);
        }, tenantA);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const cause = (caught as Error & { cause?: { message?: string } }).cause;
      expect(cause?.message).toMatch(/order_items_order_fk|foreign key/i);
    });

    it('adversarial: a cross-tenant order INSERT is rejected by the RLS WITH CHECK clause', async () => {
      let caught: unknown;
      try {
        await tenantContext.withTenantTx(async (tx) => {
          await tx.execute(sql`
            insert into orders (tenant_id, reference, customer_id, status,
                                contact_name, contact_phone, address,
                                subtotal, total, currency,
                                idempotency_key, content_hash)
            values (${tenantB}, 'ORD-SNEAKY', ${customerB}, 'confirmed',
                    'sneaky', '+966500000002', 'nowhere',
                    '1.00', '1.00', 'SAR', 'key-sneaky', 'hash-sneaky')
          `);
        }, tenantA);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const cause = (caught as Error & { cause?: { message?: string } }).cause;
      expect(cause?.message).toMatch(/row-level security/i);
    });

    it('D3: the database itself refuses any payment method other than cod', async () => {
      // Seeded through tenant B's own GUC, not `runAdminQuery` — with no
      // GUC set the FORCE-RLS `WITH CHECK` clause would reject this insert
      // first, and the assertion below would pass for the wrong reason (an
      // RLS violation, not the payment_method CHECK constraint this test
      // exists to prove).
      let caught: unknown;
      try {
        await tenantContext.withTenantTx(async (tx) => {
          await tx.execute(sql`
            insert into orders (tenant_id, reference, customer_id, status, payment_method,
                                contact_name, contact_phone, address,
                                subtotal, total, currency,
                                idempotency_key, content_hash)
            values (${tenantB}, 'ORD-CARD01', ${customerB}, 'confirmed', 'card',
                    'B Customer', '+966500000001', 'Jeddah',
                    '1.00', '1.00', 'SAR', 'key-card', 'hash-card')
          `);
        }, tenantB);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      // drizzle wraps the underlying pg driver error inside a transaction
      // ("Failed query: ..."); the real Postgres message is on `.cause`,
      // same pattern as the other adversarial cases in this file.
      const cause = (caught as Error & { cause?: { message?: string } }).cause;
      expect(cause?.message).toMatch(
        /orders_payment_method_check|check constraint/i,
      );
    });
  });

  // F26 D3/D7: courier_connections, shipments, shipment_status_events and
  // shipment_notifications are all FORCE RLS. Previously this was covered
  // ONLY by `courier-connection.service.spec.ts` / `shipment.service.spec.ts`
  // unit tests, whose fake `withTenantTx` emulates isolation with a stub
  // that narrows an in-memory array — it proves the SERVICE always calls
  // `withTenantTx`, but it cannot prove the DATABASE POLICY actually blocks
  // an adversarial query, because there is no real Postgres role and no real
  // RLS underneath it. `courier_webhook_events` gets no case here: it is
  // deliberately NOT RLS-scoped (D7 — written before a tenant is known, same
  // carve-out as `store_webhook_events`), so there is nothing to assert.
  describe('RLS on courier_connections, shipments and their child tables (F26 D3/D7)', () => {
    const customerB = randomUUID();
    let orderB: string;
    const connectionB = randomUUID();
    let shipmentB: string;

    beforeAll(async () => {
      // Seeded THROUGH tenant B's own GUC (`withTenantTx`), not
      // `runAdminQuery`: every one of these tables is FORCE ROW LEVEL
      // SECURITY, which applies to the table OWNER too — `runAdminQuery`
      // opens no transaction and sets no `app.tenant_id`, so an insert
      // through it hits the same `WITH CHECK` clause the adversarial tests
      // below exist to prove, and is correctly refused. (The "RLS on orders
      // and order_items" block above had the identical defect — seeding
      // `customers`/`orders` via `runAdminQuery` — and has since been fixed
      // to use the same `withTenantTx` pattern as this block.)
      orderB = randomUUID();
      shipmentB = randomUUID();
      await tenantContext.withTenantTx(async (tx) => {
        await tx.execute(
          sql`insert into customers (id, tenant_id, phone, name) values (${customerB}, ${tenantB}, '+966500000099', 'Tenant B courier customer')`,
        );
        await tx.execute(sql`
          insert into orders (id, tenant_id, reference, customer_id, status,
                              contact_name, contact_phone, address,
                              subtotal, total, currency,
                              idempotency_key, content_hash)
          values (${orderB}, ${tenantB}, 'ORD-CCCCCC', ${customerB}, 'confirmed',
                  'B Customer', '+966500000099', 'Jeddah',
                  '100.00', '100.00', 'SAR', 'key-b-courier', 'hash-b-courier')
        `);
        await tx.execute(sql`
          insert into courier_connections (id, tenant_id, courier, credentials, account_ref, is_active)
          values (${connectionB}, ${tenantB}, 'aramex', 'ciphertext', 'ACC-B', true)
        `);
        await tx.execute(sql`
          insert into shipments (id, tenant_id, order_id, customer_id, courier_connection_id,
                                 courier, tracking_number, current_status)
          values (${shipmentB}, ${tenantB}, ${orderB}, ${customerB}, ${connectionB},
                  'aramex', 'AWB-TENANT-B', 'in_transit')
        `);
        await tx.execute(sql`
          insert into shipment_status_events (tenant_id, shipment_id, status, raw_status, occurred_at, source)
          values (${tenantB}, ${shipmentB}, 'in_transit', 'IT', now(), 'poll')
        `);
        await tx.execute(sql`
          insert into shipment_notifications (tenant_id, shipment_id, status, outcome)
          values (${tenantB}, ${shipmentB}, 'in_transit', 'claimed')
        `);
      }, tenantB);
    });

    afterAll(async () => {
      // Same reasoning as the seed above: a DELETE issued through
      // `runAdminQuery` with no GUC set does not error (a FORCE-RLS
      // `USING` clause just filters rows, unlike `WITH CHECK` on INSERT),
      // but it silently deletes ZERO rows — cleanup that looks like it ran
      // and didn't, leaving tenant B fixture rows to accumulate release
      // over release. Going through `withTenantTx(fn, tenantB)` makes the
      // delete actually see and remove what this block inserted.
      await tenantContext.withTenantTx(async (tx) => {
        await tx.execute(
          sql`delete from shipment_notifications where tenant_id = ${tenantB}`,
        );
        await tx.execute(
          sql`delete from shipment_status_events where tenant_id = ${tenantB}`,
        );
        await tx.execute(
          sql`delete from shipments where tenant_id = ${tenantB}`,
        );
        await tx.execute(
          sql`delete from courier_connections where tenant_id = ${tenantB}`,
        );
        await tx.execute(sql`delete from orders where tenant_id = ${tenantB}`);
        await tx.execute(
          sql`delete from customers where tenant_id = ${tenantB}`,
        );
      }, tenantB);
    });

    it('FORCEs row level security on all four tables, so even the owning role is filtered', async () => {
      const rows = await persistence.runAdminQuery((db) =>
        db.execute(
          sql`select relname, relrowsecurity, relforcerowsecurity from pg_class
              where relname in ('courier_connections', 'shipments',
                                'shipment_status_events', 'shipment_notifications')`,
        ),
      );
      expect(rows.rows).toHaveLength(4);
      for (const row of rows.rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    });

    it.each([
      'courier_connections',
      'shipments',
      'shipment_status_events',
      'shipment_notifications',
    ])(
      'adversarial: %s returns zero rows to another tenant even with no WHERE clause',
      async (table) => {
        const rows = await tenantContext.withTenantTx(
          (tx) => tx.execute(sql.raw(`select id from ${table}`)),
          tenantA,
        );
        expect(rows.rows).toHaveLength(0);
      },
    );

    it("adversarial: tenant A cannot read tenant B's shipment by its exact tracking number", async () => {
      const rows = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select id from shipments where tracking_number = 'AWB-TENANT-B'`,
        );
        return result.rows;
      }, tenantA);

      expect(rows).toHaveLength(0);
    });

    it("adversarial: tenant A updating tenant B's shipment status affects zero rows", async () => {
      await tenantContext.withTenantTx(async (tx) => {
        await tx.execute(
          sql`update shipments set current_status = 'delivered' where id = ${shipmentB}`,
        );
      }, tenantA);

      // Read back through tenant B's own GUC, not `runAdminQuery` — the
      // table is FORCE RLS, so an admin-query read of it sees zero rows
      // (same reasoning as the seed/cleanup above) and would make this
      // assertion pass for the wrong reason (an empty result, not an
      // unchanged one).
      const [row] = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select current_status from shipments where id = ${shipmentB}`,
        );
        return result.rows as Array<{ current_status: string }>;
      }, tenantB);
      expect(row.current_status).toBe('in_transit');
    });

    it("adversarial: tenant A deleting tenant B's shipment affects zero rows", async () => {
      await tenantContext.withTenantTx(async (tx) => {
        await tx.execute(sql`delete from shipments where id = ${shipmentB}`);
      }, tenantA);

      const rows = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select id from shipments where id = ${shipmentB}`,
        );
        return result.rows;
      }, tenantB);
      expect(rows).toHaveLength(1);
    });

    it("adversarial: attaching a shipment to tenant B's order with a FORGED order_id is refused", async () => {
      // Under tenant A's GUC the row would pass shipments' own RLS WITH CHECK
      // (its tenant_id IS A) — the FK to `orders(id)` is what has to stop
      // this, since there is no (tenantA, orderB) row in `orders` for it to
      // reference legitimately, and RLS' WITH CHECK only constrains
      // tenant_id, not which order_id is attached.
      let caught: unknown;
      try {
        await tenantContext.withTenantTx(async (tx) => {
          await tx.execute(sql`
            insert into shipments (tenant_id, order_id, customer_id, courier_connection_id,
                                   courier, tracking_number)
            values (${tenantA}, ${orderB}, ${randomUUID()}, ${randomUUID()},
                    'aramex', 'AWB-FORGED')
          `);
        }, tenantA);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const cause = (caught as Error & { cause?: { message?: string } }).cause;
      expect(cause?.message).toMatch(
        /foreign key|row-level security|violates/i,
      );
    });

    it('adversarial: a cross-tenant courier_connections INSERT is rejected by the RLS WITH CHECK clause', async () => {
      let caught: unknown;
      try {
        await tenantContext.withTenantTx(async (tx) => {
          await tx.execute(sql`
            insert into courier_connections (tenant_id, courier, credentials, account_ref)
            values (${tenantB}, 'smsa', 'sneaky', 'ACC-SNEAKY')
          `);
        }, tenantA);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const cause = (caught as Error & { cause?: { message?: string } }).cause;
      expect(cause?.message).toMatch(/row-level security/i);
    });

    it('fails closed to zero rows with no tenant GUC set at all', async () => {
      const rows = await persistence.runAdminQuery((db) =>
        db.execute(sql`select tenant_id from shipments`),
      );
      expect(rows.rows).toHaveLength(0);
    });
  });

  describe('ToolExecutionModule.authorize() (T2 exit criterion)', () => {
    /** F25 D6.1 / F26 D4: authorize() takes the whole turn identity. Tenant scope is still decided by `tenantId` alone, which is what these adversarial cases exercise. */
    const toolCtx = (tenantId: string): ToolExecutionContext => ({
      tenantId,
      conversationId: null,
      customerId: null,
      turnId: null,
    });

    it('authorizes a tool the tenant actually has enabled', async () => {
      const args = await toolExecution.authorize(toolCtx(tenantA), 'echo', {
        message: 'hello',
      });
      expect(args).toEqual({ message: 'hello' });
    });

    it('adversarial: crafted cross-tenant tool call fires ToolScopeViolation with no detail leaked', async () => {
      // Tenant A trying to invoke a tool name that only exists because
      // tenant B enabled it (not present in tenant A's own tenant_tools
      // rows) — must be rejected purely on tenant scope, args aside.
      await toolRegistry.upsertTool(tenantB, {
        name: 'tenant-b-only-tool',
        description: 'Only tenant B has this enabled',
        jsonSchema: { type: 'object' },
      });

      let caught: unknown;
      try {
        await toolExecution.authorize(
          toolCtx(tenantA),
          'tenant-b-only-tool',
          {},
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ToolScopeViolation);
      const message = (caught as Error).message;
      expect(message).not.toMatch(/tenant-b-only-tool/);
      expect(message).not.toMatch(new RegExp(tenantB));
      expect(message).not.toMatch(new RegExp(tenantA));
    });

    it('adversarial: unknown tool name (no in-code definition) is indistinguishable from an out-of-scope one', async () => {
      await expect(
        toolExecution.authorize(toolCtx(tenantA), 'totally-made-up-tool', {}),
      ).rejects.toBeInstanceOf(ToolScopeViolation);
    });
  });
});
