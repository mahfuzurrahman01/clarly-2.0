import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { IntakeField } from '../agent-config/intake-fields';
import { IntakeService } from './intake.service';

const TENANT_A = 'tenant-a';
const CONVERSATION_ID = 'conv-1';
const CUSTOMER_ID = 'customer-1';

const FIELDS: IntakeField[] = [
  {
    key: 'order_number',
    label: 'Order number',
    type: 'text',
    required: true,
    scope: 'conversation',
  },
  {
    key: 'full_name',
    label: 'Full name',
    type: 'text',
    required: false,
    scope: 'customer',
  },
];

function makeTenantContext() {
  const inserts: { table: string; values: Record<string, unknown> }[] = [];
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const tx = {
      insert: (table: { _: { name: string } }) => ({
        values: (values: Record<string, unknown>) => {
          inserts.push({
            table: table._?.name ?? '?',
            values,
          });
          return { onConflictDoUpdate: () => Promise.resolve(undefined) };
        },
      }),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    };
    return fn(tx);
  });

  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    inserts,
  };
}

describe('IntakeService.record()', () => {
  it('routes a conversation-scoped value and a customer-scoped one to different tables', async () => {
    const { tenantContext, inserts } = makeTenantContext();
    const service = new IntakeService(tenantContext);

    const result = await service.record({
      tenantId: TENANT_A,
      conversationId: CONVERSATION_ID,
      customerId: CUSTOMER_ID,
      fields: FIELDS,
      captured: { order_number: 'A-3391', full_name: 'Ayesha' },
    });

    expect(result.stored.sort()).toEqual(['full_name', 'order_number']);
    expect(inserts).toHaveLength(2);
    // The conversation-scoped row carries a conversationId, the
    // customer-scoped one a customerId — that split is the whole point.
    expect(inserts.some((i) => 'conversationId' in i.values)).toBe(true);
    expect(inserts.some((i) => 'customerId' in i.values)).toBe(true);
  });

  it('drops a key nobody configured rather than storing what the model invented', async () => {
    const { tenantContext, inserts } = makeTenantContext();
    const service = new IntakeService(tenantContext);

    const result = await service.record({
      tenantId: TENANT_A,
      conversationId: CONVERSATION_ID,
      customerId: CUSTOMER_ID,
      fields: FIELDS,
      captured: { customer_mood: 'annoyed' },
    });

    expect(result.stored).toEqual([]);
    expect(result.ignored).toEqual(['customer_mood']);
    expect(inserts).toHaveLength(0);
  });

  it('drops an empty value: a field that looks answered and is not is worse than a blank one', async () => {
    const { tenantContext, inserts } = makeTenantContext();
    const service = new IntakeService(tenantContext);

    const result = await service.record({
      tenantId: TENANT_A,
      conversationId: CONVERSATION_ID,
      customerId: CUSTOMER_ID,
      fields: FIELDS,
      captured: { order_number: '   ' },
    });

    expect(result.stored).toEqual([]);
    expect(inserts).toHaveLength(0);
  });
});
