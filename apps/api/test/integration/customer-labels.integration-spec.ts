// Feature 18 (Intent Labeling) exit criteria, proven against a real Postgres:
//
//   1. "a tenant B agent cannot see or set tenant A's customer labels —
//      proven by an adversarial RLS test that attempts a cross-tenant
//      read/write on `customer_labels` and asserts it is rejected, not just
//      informally verified"
//   2. "an agent's manual override persists and is not silently overwritten by
//      the next agent turn"
//
// Requires a real Postgres reachable at DATABASE_URL, connected as the
// non-superuser `app_user` role (see docs/decisions/F1-security.md) — RLS is a
// silent no-op for superusers/BYPASSRLS roles regardless of policy, so running
// this against a superuser connection would give a false pass. Run via
// `npm run test:integration` from apps/api.
//
// Modelled on tenant-isolation.integration-spec.ts, which does the same for
// `tenant_tools`. Services are constructed directly rather than through
// CustomerModule: the module pulls in Auth/Audit/Billing for its HTTP surface,
// none of which is under test here, and the isolation guarantee lives in the
// database and the service, not in the controller.
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { CoreModule } from '../../src/modules/core/core.module';
import { CustomerLabelService } from '../../src/modules/customer/customer-label.service';
import { tenants } from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';

const HUMAN_USER_ID = '99999999-9999-9999-9999-999999999999';

describe('customer_labels (Feature 18)', () => {
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let labels: CustomerLabelService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let customerA: string;
  let customerB: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, PersistenceModule, TenantContextModule],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    labels = new CustomerLabelService(tenantContext);

    await persistence.runMigrations();

    // `tenants` isn't RLS-scoped (see tenants.table.ts) — seeded via the
    // PersistenceService admin escape hatch, not withTenantTx().
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'Tenant A' },
        { id: tenantB, name: 'Tenant B' },
      ]),
    );

    // Customers are seeded with raw, tenant-scoped SQL rather than through
    // CustomerService: this suite is about `customer_labels`, and going
    // through the profile service would couple it to that service's own
    // upsert shape.
    customerA = await seedCustomer(tenantA, '15550001');
    customerB = await seedCustomer(tenantB, '15550002');
  });

  /** Inserts under the tenant's own GUC — `customers` is RLS-FORCEd, so an admin connection with no tenant context could not write this row at all. */
  async function seedCustomer(
    tenantId: string,
    phone: string,
  ): Promise<string> {
    return tenantContext.withTenantTx(async (tx) => {
      const result = await tx.execute(
        sql`insert into customers (tenant_id, phone) values (${tenantId}, ${phone}) returning id`,
      );
      return (result.rows[0] as { id: string }).id;
    }, tenantId);
  }

  /** Same reason as seedCustomer: RLS means there is no tenant-blind way to clear these. */
  async function truncateLabels(): Promise<void> {
    for (const tenantId of [tenantA, tenantB]) {
      await tenantContext.withTenantTx(
        (tx) =>
          tx.execute(
            sql`delete from customer_labels where tenant_id = ${tenantId}`,
          ),
        tenantId,
      );
    }
  }

  afterAll(async () => {
    // Deleting the tenants cascades to their customers and, through the
    // composite FK, to their labels.
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(sql`${tenants.id} in (${tenantA}, ${tenantB})`),
    );
    await persistence.onModuleDestroy();
  });

  beforeEach(async () => {
    await truncateLabels();
  });

  describe('the A5 write path', () => {
    it('labels a customer from the escalation decision of a single turn', async () => {
      const record = await labels.applyAgentSignal(tenantA, customerA, {
        escalate: true,
        escalationReason: 'EXPLICIT_USER_REQUEST',
        escalationSource: 'agent_decision',
      });

      expect(record).toMatchObject({
        customerId: customerA,
        label: 'hot',
        source: 'agent',
        agentLabel: 'hot',
      });
      expect(record?.agentEvaluatedAt).toBeInstanceOf(Date);
    });

    it('updates the same row on the next turn rather than accumulating one row per turn', async () => {
      await labels.applyAgentSignal(tenantA, customerA, {
        escalate: true,
        escalationReason: 'EXPLICIT_USER_REQUEST',
        escalationSource: 'agent_decision',
      });
      await labels.applyAgentSignal(tenantA, customerA, {
        escalate: false,
        escalationReason: null,
        escalationSource: null,
      });

      const rows = await tenantContext.withTenantTx(
        (tx) =>
          tx.execute(
            sql`select label from customer_labels where customer_id = ${customerA}`,
          ),
        tenantA,
      );
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as { label: string }).label).toBe('cold');
    });

    it('writes nothing at all for an error_forced escalation (D13)', async () => {
      const record = await labels.applyAgentSignal(tenantA, customerA, {
        escalate: true,
        escalationReason: 'LLM_ERROR',
        escalationSource: 'error_forced',
      });

      expect(record).toBeNull();
      await expect(labels.get(tenantA, customerA)).resolves.toBeNull();
    });
  });

  describe('override-wins precedence (locked decision)', () => {
    it('a human override survives the next agent turn, and the one after that', async () => {
      await labels.applyAgentSignal(tenantA, customerA, {
        escalate: false,
        escalationReason: null,
        escalationSource: null,
      });

      const overridden = await labels.override(
        tenantA,
        customerA,
        'hot',
        HUMAN_USER_ID,
      );
      expect(overridden).toMatchObject({ label: 'hot', source: 'human' });

      // Two more agent turns, both of which would set 'cold' on an
      // un-overridden customer.
      await labels.applyAgentSignal(tenantA, customerA, {
        escalate: false,
        escalationReason: null,
        escalationSource: null,
      });
      const after = await labels.applyAgentSignal(tenantA, customerA, {
        escalate: false,
        escalationReason: null,
        escalationSource: null,
      });

      expect(after).toMatchObject({
        label: 'hot',
        source: 'human',
        overriddenBy: HUMAN_USER_ID,
        // The agent kept evaluating and its opinion is recorded — it just did
        // not get to change the label.
        agentLabel: 'cold',
      });
      await expect(labels.get(tenantA, customerA)).resolves.toMatchObject({
        label: 'hot',
      });
    });

    it('accepts a tenant-defined label, not just hot/warm/cold, and defends it the same way', async () => {
      await labels.override(tenantA, customerA, 'renewal-risk', HUMAN_USER_ID);

      await labels.applyAgentSignal(tenantA, customerA, {
        escalate: true,
        escalationReason: 'CUSTOMER_DISTRESS',
        escalationSource: 'agent_decision',
      });

      await expect(labels.get(tenantA, customerA)).resolves.toMatchObject({
        label: 'renewal-risk',
        agentLabel: 'hot',
      });
    });

    it('overrides a customer the agent has never had a turn with', async () => {
      const record = await labels.override(
        tenantA,
        customerA,
        'hot',
        HUMAN_USER_ID,
      );

      expect(record).toMatchObject({ label: 'hot', source: 'human' });
      expect(record.agentLabel).toBeNull();
    });

    it("clearing the override hands the label straight back to the agent's current opinion", async () => {
      await labels.applyAgentSignal(tenantA, customerA, {
        escalate: false,
        escalationReason: null,
        escalationSource: null,
      });
      await labels.override(tenantA, customerA, 'hot', HUMAN_USER_ID);

      const cleared = await labels.clearOverride(tenantA, customerA);

      expect(cleared).toMatchObject({
        label: 'cold',
        source: 'agent',
        overriddenAt: null,
        overriddenBy: null,
      });
    });

    it('after clearing, the next agent turn writes the label again', async () => {
      await labels.override(tenantA, customerA, 'hot', HUMAN_USER_ID);
      await labels.clearOverride(tenantA, customerA);

      await labels.applyAgentSignal(tenantA, customerA, {
        escalate: true,
        escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
        escalationSource: 'agent_decision',
      });

      await expect(labels.get(tenantA, customerA)).resolves.toMatchObject({
        label: 'warm',
        source: 'agent',
      });
    });

    it('keeps a human-only label when the override is cleared and the agent has never evaluated', async () => {
      await labels.override(tenantA, customerA, 'renewal-risk', HUMAN_USER_ID);

      await expect(
        labels.clearOverride(tenantA, customerA),
      ).resolves.toMatchObject({ label: 'renewal-risk', source: 'agent' });
    });
  });

  describe('adversarial cross-tenant access (Feature 18 exit criterion 3)', () => {
    beforeEach(async () => {
      await labels.applyAgentSignal(tenantA, customerA, {
        escalate: true,
        escalationReason: 'EXPLICIT_USER_REQUEST',
        escalationSource: 'agent_decision',
      });
    });

    it("tenant B's own read path cannot see tenant A's label", async () => {
      // Tenant B naming tenant A's customer id outright — the most direct
      // attempt there is.
      await expect(labels.get(tenantB, customerA)).resolves.toBeNull();
      await expect(labels.get(tenantB, customerB)).resolves.toBeNull();
    });

    it("adversarial: a hand-crafted SELECT with no tenant predicate, run under tenant B's GUC, returns zero of tenant A's rows", async () => {
      const rows = await tenantContext.withTenantTx(async (tx) => {
        // Deliberately does NOT filter by tenant_id — RLS is the only thing
        // that can stop this from returning tenant A's label.
        const result = await tx.execute(sql`select * from customer_labels`);
        return result.rows;
      }, tenantB);

      expect(rows).toHaveLength(0);
    });

    it("adversarial: a cross-tenant INSERT under tenant A's tenant_id is rejected by the RLS WITH CHECK clause", async () => {
      let caught: unknown;
      try {
        await tenantContext.withTenantTx(async (tx) => {
          await tx.execute(
            sql`insert into customer_labels (tenant_id, customer_id, label) values (${tenantA}, ${customerA}, 'planted')`,
          );
        }, tenantB);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      // drizzle wraps the pg driver error; the real Postgres message (code
      // 42501, insufficient privilege) is on `.cause`.
      const cause = (caught as Error & { cause?: { message?: string } }).cause;
      expect(cause?.message).toMatch(/row-level security/i);
    });

    it("adversarial: relabelling tenant A's customer under tenant B's OWN tenant_id is rejected by the composite foreign key", async () => {
      // The subtler attack, and the one RLS alone does not stop: the WITH
      // CHECK clause only constrains `tenant_id`, so a row claiming B's tenant
      // while pointing at A's customer satisfies it. The composite FK to
      // (customers.tenant_id, customers.id) is what makes it impossible.
      let caught: unknown;
      try {
        await labels.override(tenantB, customerA, 'planted', HUMAN_USER_ID);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const cause = (caught as Error & { cause?: { code?: string } }).cause;
      expect(cause?.code).toBe('23503'); // foreign_key_violation
    });

    it("adversarial: tenant B's UPDATE of tenant A's label affects zero rows and leaves it untouched", async () => {
      const result = await tenantContext.withTenantTx(
        (tx) =>
          tx.execute(
            sql`update customer_labels set label = 'hacked', overridden_at = now() where tenant_id = ${tenantA}`,
          ),
        tenantB,
      );

      expect(result.rowCount).toBe(0);
      await expect(labels.get(tenantA, customerA)).resolves.toMatchObject({
        label: 'hot',
        source: 'agent',
      });
    });

    it("adversarial: tenant B's DELETE of tenant A's label affects zero rows", async () => {
      const result = await tenantContext.withTenantTx(
        (tx) => tx.execute(sql`delete from customer_labels`),
        tenantB,
      );

      expect(result.rowCount).toBe(0);
      await expect(labels.get(tenantA, customerA)).resolves.not.toBeNull();
    });

    it("adversarial: an agent-path write from tenant B cannot touch tenant A's label either", async () => {
      // The write path, not just raw SQL — B replaying the respond path
      // against A's customer id.
      let caught: unknown;
      try {
        await labels.applyAgentSignal(tenantB, customerA, {
          escalate: false,
          escalationReason: null,
          escalationSource: null,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      await expect(labels.get(tenantA, customerA)).resolves.toMatchObject({
        label: 'hot',
      });
    });

    it('fails closed to zero rows with no tenant GUC set at all', async () => {
      const rows = await persistence.runAdminQuery((db) =>
        db.execute(sql`select tenant_id from customer_labels`),
      );

      expect(rows.rows).toHaveLength(0);
    });
  });
});
