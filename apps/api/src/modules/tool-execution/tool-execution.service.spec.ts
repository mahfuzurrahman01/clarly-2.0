import type {
  BookAppointmentExecutor,
  CheckAvailabilityExecutor,
} from '../booking/booking-tool-executors';
import { LLMMalformedToolCall, ToolScopeViolation } from '@repo/errors';
import type { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import type { CatalogProductExecutor } from '../catalog/catalog-product-executor';
import type { CreateOrderExecutor } from '../order/create-order-executor';
import type { TrackOrderExecutor } from '../courier/track-order-executor';
import { TOOL_DEFINITIONS } from './tool-definitions';
import { ToolExecutionService } from './tool-execution.service';
import type { ToolExecutionContext } from './tool-execution-context';

function makeRegistry(enabledFor: Set<string>): TenantToolRegistryService {
  return {
    isToolEnabledForTenant: jest.fn((_tenantId: string, name: string) =>
      Promise.resolve(enabledFor.has(name)),
    ),
  } as unknown as TenantToolRegistryService;
}

/**
 * F20/F24 wiring: `execute()` now dispatches to the catalog and store
 * executors, so every construction needs them. The harness returns the mocks
 * alongside the service so a test can assert what was dispatched — including
 * that the tenant id reached the executor, which is the whole reason the
 * parameter exists.
 */
function makeService(enabledFor: Set<string>) {
  const catalogExecute = jest.fn().mockResolvedValue({
    products: [],
    message: 'No matching products found',
    guidance: 'no-match guidance',
  });
  const createOrderExecute = jest.fn().mockResolvedValue({
    orderId: 'order-1',
    orderNumber: '1001',
    total: '0',
    currency: 'SAR',
  });

  // F26: the one executor that reads a turn-scoped field.
  const trackOrderExecute = jest
    .fn()
    .mockResolvedValue({ shipments: [], guidance: 'no-shipment guidance' });

  // Clarly 2.0 S2: the two booking executors.
  const checkAvailabilityExecute = jest
    .fn()
    .mockResolvedValue({ status: 'ok', days: [] });
  const bookAppointmentExecute = jest
    .fn()
    .mockResolvedValue({ status: 'requested', bookingReference: 'BK-2222AA' });

  const service = new ToolExecutionService(
    makeRegistry(enabledFor),
    { execute: catalogExecute } as unknown as CatalogProductExecutor,
    { execute: createOrderExecute } as unknown as CreateOrderExecutor,
    { execute: trackOrderExecute } as unknown as TrackOrderExecutor,
    {
      execute: checkAvailabilityExecute,
    } as unknown as CheckAvailabilityExecutor,
    { execute: bookAppointmentExecute } as unknown as BookAppointmentExecutor,
  );

  return {
    service,
    catalogExecute,
    createOrderExecute,
    trackOrderExecute,
    checkAvailabilityExecute,
    bookAppointmentExecute,
  };
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CUSTOMER_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TURN_A = 'coalesce-tenant-a-window-1';

/** F25 D6.1 / F26 D4: authorize()/execute() take the whole turn identity, not a bare tenant id. */
function ctxFor(tenantId: string): ToolExecutionContext {
  return {
    tenantId,
    conversationId: CONVERSATION_A,
    customerId: CUSTOMER_A,
    turnId: TURN_A,
  };
}

const ctxA = ctxFor(TENANT_A);
const ctxB = ctxFor(TENANT_B);

describe('ToolExecutionService.authorize()', () => {
  it('returns parsed args for a tool the tenant has enabled with valid args', async () => {
    const { service } = makeService(new Set(['echo']));

    const result = await service.authorize(ctxA, 'echo', {
      message: 'hi',
    });

    expect(result).toEqual({ message: 'hi' });
  });

  it('throws ToolScopeViolation for a tool that exists in code but is not enabled for this tenant', async () => {
    const { service } = makeService(new Set());

    await expect(
      service.authorize(ctxA, 'echo', { message: 'hi' }),
    ).rejects.toBeInstanceOf(ToolScopeViolation);
  });

  it('throws ToolScopeViolation for a tool name with no in-code definition at all', async () => {
    const { service } = makeService(new Set(['made-up-tool']));

    await expect(
      service.authorize(ctxA, 'made-up-tool', {}),
    ).rejects.toBeInstanceOf(ToolScopeViolation);
  });

  it('does not distinguish "unknown tool" from "not enabled" in the thrown error message', async () => {
    const { service } = makeService(new Set());

    const unknownToolError = await service
      .authorize(ctxA, 'made-up-tool', {})
      .catch((error: unknown) => error as Error);
    const notEnabledError = await service
      .authorize(ctxA, 'echo', { message: 'hi' })
      .catch((error: unknown) => error as Error);

    expect(unknownToolError.message).toBe(notEnabledError.message);
  });

  it('throws LLMMalformedToolCall (not ToolScopeViolation) when the tool is in scope but args fail schema validation', async () => {
    const { service } = makeService(new Set(['echo']));

    await expect(
      service.authorize(ctxA, 'echo', { message: '' }),
    ).rejects.toBeInstanceOf(LLMMalformedToolCall);
  });

  it('rejects args with unexpected extra fields (strict schema, no additionalProperties)', async () => {
    const { service } = makeService(new Set(['echo']));

    // zod's default .object() strips unknown keys rather than rejecting —
    // assert the returned args never carry the injected field through to
    // whatever executes next.
    const result = await service.authorize(ctxA, 'echo', {
      message: 'hi',
      __proto__: { polluted: true },
      admin: true,
    });

    expect(result).toEqual({ message: 'hi' });
    expect(result).not.toHaveProperty('admin');
  });

  it('never leaks the tool name into the ToolScopeViolation message', async () => {
    const { service } = makeService(new Set());

    const error = await service
      .authorize(ctxA, 'super-secret-internal-tool-name', {})
      .catch((e: unknown) => e as Error);

    expect(error.message).not.toMatch(/super-secret-internal-tool-name/);
  });
});

describe('ToolExecutionService.execute()', () => {
  it('executes the echo scaffold tool, returning the message back', async () => {
    const { service } = makeService(new Set(['echo']));

    const result = await service.execute(ctxA, 'echo', { message: 'hi' });

    expect(result).toEqual({ message: 'hi' });
  });

  it('throws for a tool name with no execution implemented (programming error, not authorize()-checked)', async () => {
    const { service } = makeService(new Set(['echo']));

    await expect(service.execute(ctxA, 'made-up-tool', {})).rejects.toThrow(
      /no execution implemented/,
    );
  });

  it('dispatches lookup_product to the catalog executor under the caller-supplied tenant', async () => {
    const { service, catalogExecute } = makeService(
      new Set(['lookup_product']),
    );

    await service.execute(ctxB, 'lookup_product', {
      query: 'abaya',
      limit: 3,
    });

    expect(catalogExecute).toHaveBeenCalledWith(ctxB, {
      query: 'abaya',
      limit: 3,
    });
  });

  it('dispatches create_order to the store executor under the caller-supplied tenant', async () => {
    const { service, createOrderExecute } = makeService(
      new Set(['create_order']),
    );
    const args = {
      customerName: 'Fatima',
      customerPhone: '+966500000000',
      shippingAddress: '12 King Fahd Road, Riyadh',
      items: [
        { productId: '33333333-3333-3333-3333-333333333333', quantity: 2 },
      ],
    };

    await service.execute(ctxB, 'create_order', args);

    expect(createOrderExecute).toHaveBeenCalledWith(ctxB, args);
  });

  it('refuses to dispatch args that do not match the tool schema, even though authorize() normally guarantees they do', async () => {
    // execute() is only safe to call after authorize(); this asserts the
    // fallback if a future caller forgets — the executor must not be handed
    // an unvalidated payload just because the cast would have compiled.
    const { service, createOrderExecute } = makeService(
      new Set(['create_order']),
    );

    await expect(
      service.execute(ctxA, 'create_order', {
        customerName: 'Fatima',
        items: 'not-an-array',
      }),
    ).rejects.toBeInstanceOf(LLMMalformedToolCall);
    expect(createOrderExecute).not.toHaveBeenCalled();
  });

  // --- F25 D6.1 / F26 D4: ToolExecutionContext threading ---

  it('passes the WHOLE context object through to the executor, not just the tenant id', async () => {
    const { service, catalogExecute } = makeService(
      new Set(['lookup_product']),
    );

    await service.execute(ctxB, 'lookup_product', { query: 'abaya' });

    const [receivedCtx] = catalogExecute.mock.calls[0] as [
      ToolExecutionContext,
    ];
    expect(receivedCtx).toEqual({
      tenantId: TENANT_B,
      conversationId: CONVERSATION_A,
      customerId: CUSTOMER_A,
      turnId: TURN_A,
    });
  });

  it('scopes the tenant_tools check to ctx.tenantId — a context for another tenant is not authorized', async () => {
    const isToolEnabledForTenant = jest.fn((_t: string, name: string) =>
      Promise.resolve(name === 'lookup_product'),
    );
    const service = new ToolExecutionService(
      { isToolEnabledForTenant } as unknown as TenantToolRegistryService,
      { execute: jest.fn() } as unknown as CatalogProductExecutor,
      { execute: jest.fn() } as unknown as CreateOrderExecutor,
      { execute: jest.fn() } as unknown as TrackOrderExecutor,
      { execute: jest.fn() } as unknown as CheckAvailabilityExecutor,
      { execute: jest.fn() } as unknown as BookAppointmentExecutor,
    );

    await service.authorize(ctxB, 'lookup_product', { query: 'abaya' });

    expect(isToolEnabledForTenant).toHaveBeenCalledWith(
      TENANT_B,
      'lookup_product',
    );
  });

  it('executes normally for a context whose turn-scoped fields are all null (the non-conversational caller, e.g. CommentReplyAgent)', async () => {
    // Backwards compatibility with F20/F24: `lookup_product` only ever needed
    // a tenant, so a comment turn with no conversation/customer/turn must keep
    // working exactly as it did before this seam existed.
    const { service, catalogExecute } = makeService(
      new Set(['lookup_product']),
    );
    const commentCtx: ToolExecutionContext = {
      tenantId: TENANT_A,
      conversationId: null,
      customerId: null,
      turnId: null,
    };

    await service.execute(commentCtx, 'lookup_product', { query: 'abaya' });

    expect(catalogExecute).toHaveBeenCalledWith(commentCtx, {
      query: 'abaya',
    });
  });
});

describe('ToolExecutionService — track_order (F26 D4)', () => {
  it('dispatches to the track_order executor with the whole turn identity', async () => {
    const { service, trackOrderExecute } = makeService(
      new Set(['track_order']),
    );

    await service.execute(ctxA, 'track_order', { orderReference: '#1234' });

    // The executor derives the asking customer from `ctx`, never from args.
    expect(trackOrderExecute).toHaveBeenCalledWith(ctxA, {
      orderReference: '#1234',
    });
  });

  // An identity the model can fill is an identity a customer can talk the
  // model into filling with someone else's value. The schema refuses the call
  // rather than quietly dropping the field, so the attempt is auditable.
  it('rejects an args object carrying an injected identity field', async () => {
    const { service, trackOrderExecute } = makeService(
      new Set(['track_order']),
    );

    await expect(
      service.authorize(ctxA, 'track_order', {
        orderReference: '#1234',
        customerPhone: '+966500000000',
      }),
    ).rejects.toBeInstanceOf(LLMMalformedToolCall);
    expect(trackOrderExecute).not.toHaveBeenCalled();
  });

  it('accepts a call with neither reference: the scope comes from context, not args', async () => {
    const { service } = makeService(new Set(['track_order']));

    await expect(service.authorize(ctxA, 'track_order', {})).resolves.toEqual(
      {},
    );
  });

  it('is still gated by the tenant allowlist like every other tool', async () => {
    const { service } = makeService(new Set());

    await expect(
      service.authorize(ctxA, 'track_order', { orderReference: '#1' }),
    ).rejects.toBeInstanceOf(ToolScopeViolation);
  });
});

describe('TOOL_DEFINITIONS', () => {
  it('registers the F20 catalog, F24 store and F26 courier tools so a tenant can actually be granted them', () => {
    // The tenant_tools allowlist is checked against this map: a tool missing
    // here is unreachable no matter what the tenant has enabled.
    expect(Object.keys(TOOL_DEFINITIONS)).toEqual(
      expect.arrayContaining([
        'echo',
        'lookup_product',
        'create_order',
        'track_order',
      ]),
    );
  });
});

describe('ToolExecutionService — v2 booking tools', () => {
  const ctx = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    conversationId: '22222222-2222-4222-8222-222222222222',
    customerId: '33333333-3333-4333-8333-333333333333',
    turnId: 'turn-1',
  };

  it('refuses check_availability for a tenant without the tool row (bookings disabled)', async () => {
    const { service } = makeService(new Set());
    await expect(
      service.authorize(ctx, 'check_availability', { service: 'Cleaning' }),
    ).rejects.toBeInstanceOf(ToolScopeViolation);
  });

  it('authorizes and routes check_availability to its executor with the same ctx', async () => {
    const { service, checkAvailabilityExecute } = makeService(
      new Set(['check_availability']),
    );
    const args = await service.authorize(ctx, 'check_availability', {
      service: 'Cleaning',
      date: '2026-10-08',
    });
    await service.execute(ctx, 'check_availability', args);
    expect(checkAvailabilityExecute).toHaveBeenCalledWith(ctx, {
      service: 'Cleaning',
      date: '2026-10-08',
    });
  });

  it('rejects a book_appointment call with a malformed time', async () => {
    const { service } = makeService(new Set(['book_appointment']));
    await expect(
      service.authorize(ctx, 'book_appointment', {
        service: 'Cleaning',
        date: '2026-10-08',
        time: '4:30pm',
        customerName: 'Sara',
      }),
    ).rejects.toBeInstanceOf(LLMMalformedToolCall);
  });

  it('routes book_appointment to its executor', async () => {
    const { service, bookAppointmentExecute } = makeService(
      new Set(['book_appointment']),
    );
    const args = await service.authorize(ctx, 'book_appointment', {
      service: 'Cleaning',
      date: '2026-10-08',
      time: '16:30',
      customerName: 'Sara',
    });
    await service.execute(ctx, 'book_appointment', args);
    expect(bookAppointmentExecute).toHaveBeenCalledTimes(1);
  });
});
