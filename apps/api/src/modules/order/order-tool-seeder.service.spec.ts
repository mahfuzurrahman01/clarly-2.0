// F25 D1.2 gate 1: the registry gate.
//
// Without an enabled `tenant_tools` row the tool is never rendered into L3 —
// the model is not told `create_order` exists, so there is nothing for a
// prompt injection to reach for. That is the strongest form of exit criterion
// 3, and these tests are what keep it tied to the mode.
import type { AppLoggerService } from '../core';
import type { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import { createOrderToolDefinition } from './create-order.tool';
import { OrderToolSeederService } from './order-tool-seeder.service';

const TENANT = '00000000-0000-0000-0000-00000000000a';

function makeHarness() {
  const upsertTool = jest.fn().mockResolvedValue(undefined);
  const error = jest.fn();
  const service = new OrderToolSeederService(
    { upsertTool } as unknown as TenantToolRegistryService,
    { error, log: jest.fn(), warn: jest.fn() } as unknown as AppLoggerService,
  );
  return { service, upsertTool, error };
}

describe('OrderToolSeederService.syncForMode', () => {
  it.each([['human_approval'], ['auto']] as const)(
    'enables the create_order row for %s',
    async (mode) => {
      const { service, upsertTool } = makeHarness();

      await service.syncForMode(TENANT, mode);

      expect(upsertTool).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          name: createOrderToolDefinition.name,
          enabled: true,
        }),
      );
    },
  );

  it('DISABLES rather than deletes the row when ordering is switched off', async () => {
    // Disabled, not deleted, so the row's history survives a merchant turning
    // ordering off for a week. `isToolEnabledForTenant` filters on `enabled`,
    // so a disabled row is exactly as unreachable as an absent one.
    const { service, upsertTool } = makeHarness();

    await service.syncForMode(TENANT, 'disabled');

    expect(upsertTool).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ enabled: false }),
    );
  });
});

describe('OrderToolSeederService.syncForModeBestEffort', () => {
  it('swallows a registry failure, leaving the tenant MORE restricted, never less', async () => {
    const { service, upsertTool, error } = makeHarness();
    upsertTool.mockRejectedValue(new Error('deadlock detected'));

    await expect(
      service.syncForModeBestEffort(TENANT, 'human_approval'),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});

describe('the create_order tool definition', () => {
  it('never exposes a price field for the model to fill in', () => {
    const itemSchema = (
      createOrderToolDefinition.jsonSchema.properties as Record<
        string,
        { items?: { properties?: Record<string, unknown> } }
      >
    ).items;
    // `variant` is a selector the executor checks against the chosen row, not
    // a value that reaches the order: still no price, name or total to fill.
    expect(Object.keys(itemSchema?.items?.properties ?? {})).toEqual([
      'productId',
      'quantity',
      'variant',
    ]);
  });

  it('tells the model, in the tool description itself, never to claim the order is placed', () => {
    expect(createOrderToolDefinition.description).toContain('customerMessage');
    expect(createOrderToolDefinition.description).toMatch(
      /never that it is placed, confirmed, paid or shipped/,
    );
  });

  it('takes no customer or conversation id from the model (D2.2)', () => {
    const keys = Object.keys(
      createOrderToolDefinition.jsonSchema.properties as Record<
        string,
        unknown
      >,
    );
    expect(keys).not.toContain('customerId');
    expect(keys).not.toContain('conversationId');
  });

  it('keeps the Zod schema and the JSON schema describing the same object (A2)', () => {
    const required = (
      createOrderToolDefinition.jsonSchema as { required?: string[] }
    ).required;
    expect(required).toEqual([
      'customerName',
      'customerPhone',
      'shippingAddress',
      'items',
    ]);
    // Everything the JSON schema calls required, Zod also refuses without.
    expect(createOrderToolDefinition.zodSchema.safeParse({}).success).toBe(
      false,
    );
    // And a payload the JSON schema's minItems forbids is one Zod forbids too.
    expect(
      createOrderToolDefinition.zodSchema.safeParse({
        customerName: 'A',
        customerPhone: '+966500000000',
        shippingAddress: 'Riyadh',
        items: [],
      }).success,
    ).toBe(false);
  });
});
