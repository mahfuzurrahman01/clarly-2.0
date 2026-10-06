import {
  CreateOrderInput,
  createOrderToolDefinition,
} from './create-order.tool';

const PRODUCT = '33333333-3333-3333-3333-333333333333';
const base = {
  customerName: 'Aisha',
  customerPhone: '+966501110014',
  shippingAddress: '12 Tahlia Street, Riyadh',
};

describe('create_order tool definition', () => {
  it('accepts an optional per-item variant', () => {
    const parsed = CreateOrderInput.safeParse({
      ...base,
      items: [{ productId: PRODUCT, quantity: 1, variant: 'Red' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts an item with no variant', () => {
    expect(
      CreateOrderInput.safeParse({
        ...base,
        items: [{ productId: PRODUCT, quantity: 1 }],
      }).success,
    ).toBe(true);
  });

  it('rejects an empty call so it never reaches the executor', () => {
    expect(CreateOrderInput.safeParse({}).success).toBe(false);
  });

  it('advertises the variant to the model in the same shape the schema accepts', () => {
    const items = (
      createOrderToolDefinition.jsonSchema.properties as Record<
        string,
        { items: { properties: Record<string, unknown> } }
      >
    ).items;
    expect(Object.keys(items.items.properties)).toEqual(
      expect.arrayContaining(['productId', 'quantity', 'variant']),
    );
  });

  it('tells the model to look up first and to use the last stated quantity', () => {
    expect(createOrderToolDefinition.description).toContain(
      'Call lookup_product first',
    );
    expect(createOrderToolDefinition.description).toContain(
      'final number wins',
    );
    expect(createOrderToolDefinition.description).toContain(
      'lookup_product_then_retry',
    );
  });
});
