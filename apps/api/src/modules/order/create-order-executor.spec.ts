// F25 D9: the executor's contract with the model.
//
// Three properties this file exists to hold down, because each is a way a
// language model could place a real order for real money:
//
//   1. A tenant that has not opted in cannot have an order created UNDER ANY
//      PROMPT (exit criterion 3) — the execution gate raises ToolScopeViolation
//      and NOTHING is written.
//   2. The model is never told an order is placed when it is not: the result's
//      `customerMessage` is a machine token, and in human_approval mode it is
//      the "not yet placed" one.
//   3. Prices and names in the result are the ones that were STORED, not the
//      ones the tool call claimed.
import { LLMMalformedToolCall, ToolScopeViolation } from '@repo/errors';
import type { AppLoggerService } from '../core';
import type { StoreConnectionService } from '../store/store-connection.service';
import type { ToolExecutionContext } from '../tool-execution/tool-execution-context';
import { CreateOrderExecutor } from './create-order-executor';
import type { CreateOrderInput } from './create-order.tool';
import { OrderResolutionError } from './order-item-resolution';
import type { CreateOrderResult, OrderService } from './order.service';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const CONVERSATION = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
const PRODUCT = '33333333-3333-3333-3333-333333333333';

const ctx: ToolExecutionContext = {
  tenantId: TENANT,
  conversationId: CONVERSATION,
  customerId: CUSTOMER,
  turnId: 'turn-1',
};

function args(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    customerName: 'Aisha',
    customerPhone: '+966501234567',
    shippingAddress: 'Near the big mosque, Riyadh',
    items: [{ productId: PRODUCT, quantity: 2 }],
    ...overrides,
  };
}

function orderResult(
  status: 'pending_approval' | 'confirmed',
  overrides: Partial<CreateOrderResult> = {},
): CreateOrderResult {
  return {
    order: {
      reference: 'ORD-7F3A21',
      total: '1000.00',
      currency: 'SAR',
      status,
    } as CreateOrderResult['order'],
    items: [
      {
        productName: 'Oud Perfume 50ml',
        quantity: 2,
        unitPrice: '500.00',
      } as CreateOrderResult['items'][number],
    ],
    duplicate: false,
    ...overrides,
  };
}

function makeHarness(
  createFromTurn: jest.Mock,
  connections: Array<{ id: string; provider: string }> = [],
) {
  const findActiveByTenant = jest.fn().mockResolvedValue(connections);
  const executor = new CreateOrderExecutor(
    { createFromTurn } as unknown as OrderService,
    { findActiveByTenant } as unknown as StoreConnectionService,
    { log: jest.fn(), warn: jest.fn() } as unknown as AppLoggerService,
  );
  return { executor, createFromTurn, findActiveByTenant };
}

describe('CreateOrderExecutor — the approval gate (D1.2 gate 2)', () => {
  it('propagates ToolScopeViolation from a disabled/absent settings row, writing nothing', async () => {
    const createFromTurn = jest
      .fn()
      .mockRejectedValue(new ToolScopeViolation());
    const { executor } = makeHarness(createFromTurn);

    await expect(executor.execute(ctx, args())).rejects.toBeInstanceOf(
      ToolScopeViolation,
    );
  });

  it('refuses a turn with no customer rather than inventing an identity', async () => {
    const createFromTurn = jest.fn();
    const { executor } = makeHarness(createFromTurn);

    await expect(
      executor.execute({ ...ctx, customerId: '' }, args()),
    ).rejects.toBeInstanceOf(ToolScopeViolation);
    expect(createFromTurn).not.toHaveBeenCalled();
  });

  it('refuses an empty item list before reaching the write path', async () => {
    const createFromTurn = jest.fn();
    const { executor } = makeHarness(createFromTurn);

    await expect(
      executor.execute(ctx, args({ items: [] })),
    ).rejects.toBeInstanceOf(LLMMalformedToolCall);
    expect(createFromTurn).not.toHaveBeenCalled();
  });
});

describe('CreateOrderExecutor — placeholder customer details', () => {
  it('refuses filler details, writes nothing, and names the fields to ask for', async () => {
    const createFromTurn = jest.fn();
    const { executor, findActiveByTenant } = makeHarness(createFromTurn);

    const result = await executor.execute(
      ctx,
      args({
        customerName: 'Customer',
        shippingAddress: 'Not provided yet',
      }),
    );

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'missing_customer_details',
      missingFields: ['customerName', 'shippingAddress'],
      customerMessage: 'ask_customer_for_missing_details',
    });
    expect((result as { message: string }).message).toContain('customerName');
    expect(createFromTurn).not.toHaveBeenCalled();
    expect(findActiveByTenant).not.toHaveBeenCalled();
  });

  it('refuses a phone with too few digits', async () => {
    const createFromTurn = jest.fn();
    const { executor } = makeHarness(createFromTurn);

    await expect(
      executor.execute(ctx, args({ customerPhone: 'unknown' })),
    ).resolves.toMatchObject({ missingFields: ['customerPhone'] });
    expect(createFromTurn).not.toHaveBeenCalled();
  });

  it('still places an order for real Arabic details', async () => {
    const { executor } = makeHarness(
      jest.fn().mockResolvedValue(orderResult('pending_approval')),
    );

    await expect(
      executor.execute(
        ctx,
        args({
          customerName: 'عائشة',
          shippingAddress: 'حي النخيل، شارع الملك فهد، الرياض',
        }),
      ),
    ).resolves.toMatchObject({ status: 'pending_approval' });
  });
});

describe('CreateOrderExecutor — address provenance', () => {
  it('refuses an address the customer never gave and writes nothing', async () => {
    const createFromTurn = jest.fn();
    const { executor } = makeHarness(createFromTurn);

    const result = await executor.execute(
      { ...ctx, customerText: 'I want one. Name Aisha, phone +966501234567' },
      args({ shippingAddress: 'Riyadh' }),
    );

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'missing_customer_details',
      missingFields: ['shippingAddress'],
    });
    expect(createFromTurn).not.toHaveBeenCalled();
  });

  it('does not check provenance when the caller supplied no customer text', async () => {
    const createFromTurn = jest.fn().mockResolvedValue({ order: null });
    const { executor } = makeHarness(createFromTurn);

    await executor
      .execute(ctx, args({ shippingAddress: 'Riyadh' }))
      .catch(() => undefined);

    expect(createFromTurn).toHaveBeenCalled();
  });
});

describe('CreateOrderExecutor — cycle 3 argument guards', () => {
  it('refuses an instruction phrase as the address and writes nothing', async () => {
    const createFromTurn = jest.fn();
    const { executor } = makeHarness(createFromTurn);

    await expect(
      executor.execute(
        ctx,
        args({ shippingAddress: 'Please provide your delivery address' }),
      ),
    ).resolves.toMatchObject({
      reason: 'missing_customer_details',
      missingFields: ['shippingAddress'],
    });
    expect(createFromTurn).not.toHaveBeenCalled();
  });

  it('refuses a bare country as the address', async () => {
    const createFromTurn = jest.fn();
    const { executor } = makeHarness(createFromTurn);

    await expect(
      executor.execute(
        ctx,
        args({ shippingAddress: 'المملكة العربية السعودية' }),
      ),
    ).resolves.toMatchObject({ missingFields: ['shippingAddress'] });
    expect(createFromTurn).not.toHaveBeenCalled();
  });

  it('refuses a fabricated phone', async () => {
    const createFromTurn = jest.fn();
    const { executor } = makeHarness(createFromTurn);

    await expect(
      executor.execute(ctx, args({ customerPhone: '0500000000' })),
    ).resolves.toMatchObject({ missingFields: ['customerPhone'] });
    expect(createFromTurn).not.toHaveBeenCalled();
  });

  it('passes the requested variant through to the write path', async () => {
    const createFromTurn = jest
      .fn()
      .mockResolvedValue(orderResult('pending_approval'));
    const { executor } = makeHarness(createFromTurn);

    await executor.execute(
      ctx,
      args({ items: [{ productId: PRODUCT, quantity: 1, variant: 'Red' }] }),
    );

    expect(createFromTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ productId: PRODUCT, quantity: 1, variant: 'Red' }],
      }),
    );
  });
});

describe('CreateOrderExecutor — mode routing', () => {
  it('returns the NOT-YET-PLACED token in human_approval mode', async () => {
    const { executor } = makeHarness(
      jest.fn().mockResolvedValue(orderResult('pending_approval')),
    );

    await expect(executor.execute(ctx, args())).resolves.toMatchObject({
      status: 'pending_approval',
      orderReference: 'ORD-7F3A21',
      customerMessage: 'not_yet_placed_awaiting_merchant_confirmation',
      duplicate: false,
    });
  });

  it('returns the PLACED token in auto mode', async () => {
    const { executor } = makeHarness(
      jest.fn().mockResolvedValue(orderResult('confirmed')),
    );

    await expect(executor.execute(ctx, args())).resolves.toMatchObject({
      status: 'confirmed',
      customerMessage: 'order_placed_cash_on_delivery',
    });
  });

  it('never returns a store paymentUrl to the model (D3)', async () => {
    const { executor } = makeHarness(
      jest.fn().mockResolvedValue(orderResult('confirmed')),
    );

    const result = await executor.execute(ctx, args());
    expect(result).not.toHaveProperty('paymentUrl');
    expect(result).not.toHaveProperty('storePaymentUrl');
  });

  it('flags a duplicate so the agent does not confirm the same order twice', async () => {
    const { executor } = makeHarness(
      jest
        .fn()
        .mockResolvedValue(
          orderResult('pending_approval', { duplicate: true }),
        ),
    );

    await expect(executor.execute(ctx, args())).resolves.toMatchObject({
      duplicate: true,
    });
  });
});

describe('CreateOrderExecutor — what the model is not trusted with (D2.2)', () => {
  it('takes customer and conversation from the TURN CONTEXT, never from the arguments', async () => {
    const createFromTurn = jest
      .fn()
      .mockResolvedValue(orderResult('pending_approval'));
    const { executor } = makeHarness(createFromTurn);

    await executor.execute(ctx, args());

    expect(createFromTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        conversationId: CONVERSATION,
        customerId: CUSTOMER,
        turnId: 'turn-1',
      }),
    );
  });

  it('reports the STORED price back, not one the tool call claimed', async () => {
    // The tool schema has no price field at all — this asserts the result the
    // model reads is built from what was written, so a customer who insists
    // "it was 1 riyal" cannot get that echoed back as fact.
    const { executor } = makeHarness(
      jest.fn().mockResolvedValue(orderResult('pending_approval')),
    );

    const result = await executor.execute(ctx, args());
    expect(result).toMatchObject({
      total: '1000.00',
      items: [{ name: 'Oud Perfume 50ml', quantity: 2, unitPrice: '500.00' }],
    });
  });

  it('pins ONE store connection at creation time rather than re-choosing later (D4.4)', async () => {
    const createFromTurn = jest
      .fn()
      .mockResolvedValue(orderResult('confirmed'));
    const { executor } = makeHarness(createFromTurn, [
      { id: 'conn-1', provider: 'salla' },
      { id: 'conn-2', provider: 'zid' },
    ]);

    await executor.execute(ctx, args());

    expect(createFromTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        storeConnectionId: 'conn-1',
        storeProvider: 'salla',
      }),
    );
  });

  it('creates the order with no connection at all when the tenant has no store', async () => {
    const createFromTurn = jest
      .fn()
      .mockResolvedValue(orderResult('confirmed'));
    const { executor } = makeHarness(createFromTurn, []);

    await executor.execute(ctx, args());

    expect(createFromTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        storeConnectionId: null,
        storeProvider: null,
      }),
    );
  });
});

describe('CreateOrderExecutor — catalogue refusals are answers, not loop failures', () => {
  it.each([
    ['inactive_product'],
    ['insufficient_stock'],
    ['mixed_currency'],
  ] as const)('turns a %s resolution error into a refusal', async (failure) => {
    const { executor } = makeHarness(
      jest.fn().mockRejectedValue(new OrderResolutionError(failure, 'nope')),
    );

    await expect(executor.execute(ctx, args())).resolves.toMatchObject({
      status: 'refused',
      reason: failure,
      customerMessage: 'cannot_place_order_escalate_to_team',
    });
  });

  it.each([['unknown_product'], ['variant_unavailable']] as const)(
    'turns a %s error into a refusal the model can recover from with lookup_product',
    async (failure) => {
      const { executor } = makeHarness(
        jest.fn().mockRejectedValue(new OrderResolutionError(failure, 'nope')),
      );

      const result = await executor.execute(ctx, args());
      expect(result).toMatchObject({
        status: 'refused',
        reason: failure,
        customerMessage: 'lookup_product_then_retry',
      });
      // The recovery instruction is in the payload, not left to the prompt.
      expect((result as { message: string }).message).toContain(
        'lookup_product',
      );
    },
  );

  it('lets an unexpected error through, so the loop escalates rather than lying', async () => {
    const { executor } = makeHarness(
      jest.fn().mockRejectedValue(new Error('connection reset')),
    );

    await expect(executor.execute(ctx, args())).rejects.toThrow(
      'connection reset',
    );
  });
});
