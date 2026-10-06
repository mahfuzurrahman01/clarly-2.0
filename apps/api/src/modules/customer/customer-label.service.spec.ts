// Feature 18: CustomerLabelService's own behavior.
//
// SCOPE NOTE: the override-wins precedence rule is enforced inside the SQL of
// `applyAgentSignal()`'s upsert, so it CANNOT be honestly proven here against a
// fake `tx` — a mock would only be re-asserting what this file itself stubbed.
// It is proven against a real Postgres, with real RLS, in
// test/integration/customer-labels.integration-spec.ts. What this file covers
// is the logic that lives in TypeScript: which signals produce a write at all,
// and how a row maps to the API record.
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { CustomerLabelService } from './customer-label.service';

const TENANT_A = 'tenant-a';
const CUSTOMER_ID = 'customer-1';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'label-1',
    tenantId: TENANT_A,
    customerId: CUSTOMER_ID,
    label: 'cold',
    overriddenAt: null,
    overriddenBy: null,
    agentEvaluatedAt: new Date('2026-01-01T00:00:00Z'),
    agentLabel: 'cold',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Calls through to the real withTenantTx() callback against a fake tx matching this service's exact chains — same rationale as customer.service.spec.ts. */
function makeTenantContext(responses: unknown[]): {
  tenantContext: TenantContextService;
  withTenantTx: jest.Mock;
} {
  let call = 0;
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const response = responses[call++];
    const tx = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve(response),
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve(response) }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(response) }),
        }),
      }),
    };
    return fn(tx);
  });
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
  };
}

describe('CustomerLabelService.applyAgentSignal()', () => {
  it('writes the derived label for an agent-decided turn', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([
      [makeRow({ label: 'hot', agentLabel: 'hot' })],
    ]);
    const service = new CustomerLabelService(tenantContext);

    const record = await service.applyAgentSignal(TENANT_A, CUSTOMER_ID, {
      escalate: true,
      escalationReason: 'EXPLICIT_USER_REQUEST',
      escalationSource: 'agent_decision',
    });

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
    expect(record).toMatchObject({
      customerId: CUSTOMER_ID,
      label: 'hot',
      source: 'agent',
    });
  });

  it('touches the database at all only when the signal says something about the customer', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([]);
    const service = new CustomerLabelService(tenantContext);

    const record = await service.applyAgentSignal(TENANT_A, CUSTOMER_ID, {
      escalate: true,
      escalationReason: 'LLM_ERROR',
      escalationSource: 'error_forced',
    });

    expect(record).toBeNull();
    // Not merely "wrote nothing" — never opened a transaction. An outage
    // sends every in-flight turn down this path at once.
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('reports a row carrying an override as human-sourced', async () => {
    const { tenantContext } = makeTenantContext([
      [
        makeRow({
          label: 'vip',
          agentLabel: 'cold',
          overriddenAt: new Date('2026-02-02T00:00:00Z'),
          overriddenBy: '11111111-1111-1111-1111-111111111111',
        }),
      ],
    ]);
    const service = new CustomerLabelService(tenantContext);

    const record = await service.applyAgentSignal(TENANT_A, CUSTOMER_ID, {
      escalate: false,
      escalationReason: null,
      escalationSource: null,
    });

    expect(record).toMatchObject({
      label: 'vip',
      source: 'human',
      // The agent's current opinion is still reported, so the console can show
      // that it disagrees with the pinned value.
      agentLabel: 'cold',
    });
  });
});

describe('CustomerLabelService.applyAgentLabel() (Gulf T8)', () => {
  it('writes an already-derived agent label through the same upsert', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([
      [makeRow({ label: 'hot', agentLabel: 'hot' })],
    ]);
    const service = new CustomerLabelService(tenantContext);

    const record = await service.applyAgentLabel(TENANT_A, CUSTOMER_ID, 'hot');

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
    expect(record).toMatchObject({ label: 'hot', source: 'agent' });
  });
});

describe('CustomerLabelService.get()', () => {
  it('returns null for a customer with no label row', async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const service = new CustomerLabelService(tenantContext);

    await expect(service.get(TENANT_A, CUSTOMER_ID)).resolves.toBeNull();
  });
});

describe('CustomerLabelService.override()', () => {
  it('records who pinned it and reports the label as human-sourced', async () => {
    const userId = '22222222-2222-2222-2222-222222222222';
    const { tenantContext } = makeTenantContext([
      [
        makeRow({
          label: 'hot',
          overriddenAt: new Date('2026-03-03T00:00:00Z'),
          overriddenBy: userId,
        }),
      ],
    ]);
    const service = new CustomerLabelService(tenantContext);

    const record = await service.override(TENANT_A, CUSTOMER_ID, 'hot', userId);

    expect(record).toMatchObject({
      label: 'hot',
      source: 'human',
      overriddenBy: userId,
    });
  });
});

describe('CustomerLabelService.clearOverride()', () => {
  it('returns null when there was no label row to clear', async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const service = new CustomerLabelService(tenantContext);

    await expect(
      service.clearOverride(TENANT_A, CUSTOMER_ID),
    ).resolves.toBeNull();
  });
});
