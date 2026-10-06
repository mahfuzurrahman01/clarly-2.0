// F25 D9 (pure unit, no DB, no mocks): the "whole order fails, never partial"
// rule, and the one property that matters most in this feature — the price
// comes from the `products` ROW, never from what the model said.
import {
  initialStatusForMode,
  isOrderable,
  OrderResolutionError,
  resolveOrderItems,
  type ResolvableProduct,
} from './order-item-resolution';

function product(
  overrides: Partial<ResolvableProduct> = {},
): ResolvableProduct {
  return {
    id: 'p-1',
    tenantId: 't-1',
    name: 'Oud Perfume 50ml',
    sku: 'OUD-50',
    price: '500.00',
    currency: 'SAR',
    stock: 10,
    stockStatus: 'in_stock',
    isActive: true,
    metadata: null,
    ...overrides,
  };
}

function failureOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof OrderResolutionError) return error.failure;
    throw error;
  }
  throw new Error('expected an OrderResolutionError, but none was thrown');
}

describe('resolveOrderItems', () => {
  it('prices every line from the catalogue row and sums the subtotal', () => {
    const resolved = resolveOrderItems(
      [
        { productId: 'p-1', quantity: 2 },
        { productId: 'p-2', quantity: 1 },
      ],
      [
        product(),
        product({ id: 'p-2', name: 'Incense', price: '49.50', sku: null }),
      ],
    );

    expect(resolved.subtotal).toBe('1049.50');
    expect(resolved.currency).toBe('SAR');
    expect(resolved.items).toEqual([
      expect.objectContaining({
        productId: 'p-1',
        productName: 'Oud Perfume 50ml',
        unitPrice: '500.00',
        quantity: 2,
        lineTotal: '1000.00',
      }),
      expect.objectContaining({
        productId: 'p-2',
        productName: 'Incense',
        unitPrice: '49.50',
        lineTotal: '49.50',
      }),
    ]);
  });

  it('sums in minor units, so repeated fractional lines do not drift', () => {
    const resolved = resolveOrderItems(
      [{ productId: 'p-1', quantity: 3 }],
      [product({ price: '0.10' })],
    );
    // 0.1 * 3 in float is 0.30000000000000004.
    expect(resolved.subtotal).toBe('0.30');
  });

  describe('the whole order fails — never partially (F24 D9, kept)', () => {
    it("rejects a product id that is not in the tenant's catalogue", () => {
      expect(
        failureOf(() =>
          resolveOrderItems([{ productId: 'nope', quantity: 1 }], [product()]),
        ),
      ).toBe('unknown_product');
    });

    it("reports ANOTHER TENANT's product id as simply unknown, so nothing is learned by probing", () => {
      // The caller only ever passes rows it read under this tenant's RLS
      // context, so a cross-tenant id is not in the list at all — and the
      // answer is byte-identical to a nonexistent id's.
      const crossTenant = failureOf(() =>
        resolveOrderItems([{ productId: 'p-other', quantity: 1 }], [product()]),
      );
      const nonexistent = failureOf(() =>
        resolveOrderItems(
          [{ productId: 'never-existed', quantity: 1 }],
          [product()],
        ),
      );
      expect(crossTenant).toBe(nonexistent);
    });

    it('rejects an inactive product', () => {
      expect(
        failureOf(() =>
          resolveOrderItems(
            [{ productId: 'p-1', quantity: 1 }],
            [product({ isActive: false })],
          ),
        ),
      ).toBe('inactive_product');
    });

    it('rejects insufficient stock', () => {
      expect(
        failureOf(() =>
          resolveOrderItems(
            [{ productId: 'p-1', quantity: 11 }],
            [product({ stock: 10 })],
          ),
        ),
      ).toBe('insufficient_stock');
    });

    it('orders any quantity of an untracked (null stock) product that is in stock', () => {
      const result = resolveOrderItems(
        [{ productId: 'p-1', quantity: 50 }],
        [product({ stock: null, stockStatus: 'in_stock' })],
      );
      expect(result.items[0].quantity).toBe(50);
    });

    it('rejects an untracked product marked out of stock, without quoting a count', () => {
      try {
        resolveOrderItems(
          [{ productId: 'p-1', quantity: 1 }],
          [product({ stock: null, stockStatus: 'out_of_stock' })],
        );
        throw new Error('expected an OrderResolutionError');
      } catch (error) {
        expect(error).toBeInstanceOf(OrderResolutionError);
        const failure = error as OrderResolutionError;
        expect(failure.failure).toBe('insufficient_stock');
        expect(failure.message).toBe('Oud Perfume 50ml is out of stock.');
        expect(failure.message).not.toMatch(/null/);
      }
    });

    it('rejects a mixed-currency order rather than summing SAR and AED (D2.3)', () => {
      expect(
        failureOf(() =>
          resolveOrderItems(
            [
              { productId: 'p-1', quantity: 1 },
              { productId: 'p-2', quantity: 1 },
            ],
            [product(), product({ id: 'p-2', currency: 'AED' })],
          ),
        ),
      ).toBe('mixed_currency');
    });

    it('rejects an empty item list', () => {
      expect(failureOf(() => resolveOrderItems([], [product()]))).toBe(
        'unknown_product',
      );
    });

    it('fails the WHOLE order when only the second line is bad', () => {
      expect(
        failureOf(() =>
          resolveOrderItems(
            [
              { productId: 'p-1', quantity: 1 },
              { productId: 'p-2', quantity: 99 },
            ],
            [product(), product({ id: 'p-2', stock: 1 })],
          ),
        ),
      ).toBe('insufficient_stock');
    });
  });

  describe('external ids, snapshotted at order time (D4.3)', () => {
    const linked = product({
      metadata: { source: 'salla', storeExternalId: 'salla-99' },
    });

    it('is pushable only when EVERY item resolved an external id for the pinned provider', () => {
      const resolved = resolveOrderItems(
        [{ productId: 'p-1', quantity: 1 }],
        [linked],
        { storeProvider: 'salla' },
      );
      expect(resolved.storePushable).toBe(true);
      expect(resolved.items[0]?.externalProductId).toBe('salla-99');
    });

    it('is not pushable when one item has no external id for that provider', () => {
      const resolved = resolveOrderItems(
        [
          { productId: 'p-1', quantity: 1 },
          { productId: 'p-2', quantity: 1 },
        ],
        [linked, product({ id: 'p-2' })],
        { storeProvider: 'salla' },
      );
      expect(resolved.storePushable).toBe(false);
    });

    it('ignores an external id recorded by a DIFFERENT provider', () => {
      const resolved = resolveOrderItems(
        [{ productId: 'p-1', quantity: 1 }],
        [linked],
        { storeProvider: 'zid' },
      );
      expect(resolved.items[0]?.externalProductId).toBeNull();
      expect(resolved.storePushable).toBe(false);
    });

    it('snapshots the Shopify variant id store sync records, which the draft order requires', () => {
      const resolved = resolveOrderItems(
        [{ productId: 'p-1', quantity: 1 }],
        [
          product({
            metadata: {
              source: 'shopify',
              storeExternalId: '632910392',
              shopifyVariantId: '808950810',
            },
          }),
        ],
        { storeProvider: 'shopify' },
      );
      expect(resolved.items[0]).toMatchObject({
        externalProductId: '632910392',
        externalVariantId: '808950810',
      });
    });

    it('is not pushable at all when no store connection was pinned', () => {
      const resolved = resolveOrderItems(
        [{ productId: 'p-1', quantity: 1 }],
        [linked],
      );
      expect(resolved.storePushable).toBe(false);
    });
  });
});

describe('resolveOrderItems — requested variant must exist on the product', () => {
  const black = product({
    id: 'p-black',
    name: 'Acme X200 Blender - Black',
    sku: 'X200-BLK',
  });
  const plain = product({ id: 'p-plain', name: 'Acme X200 Blender' });

  it('accepts an item whose row name carries the variant', () => {
    const resolved = resolveOrderItems(
      [{ productId: 'p-black', quantity: 1, variant: 'black' }],
      [black],
    );
    expect(resolved.items[0]?.productName).toBe('Acme X200 Blender - Black');
  });

  it('matches the variant against the sku too', () => {
    expect(() =>
      resolveOrderItems(
        [{ productId: 'p-black', quantity: 1, variant: 'BLK' }],
        [black],
      ),
    ).not.toThrow();
  });

  it('refuses the plain model when the customer asked for a variant it is not', () => {
    // The observed failure: "red X200" was written as the plain X200.
    expect(
      failureOf(() =>
        resolveOrderItems(
          [{ productId: 'p-plain', quantity: 1, variant: 'Red' }],
          [plain],
        ),
      ),
    ).toBe('variant_unavailable');
  });

  it('ignores a blank variant', () => {
    expect(() =>
      resolveOrderItems(
        [{ productId: 'p-plain', quantity: 1, variant: '  ' }],
        [plain],
      ),
    ).not.toThrow();
  });

  it('does not require a variant when none was named', () => {
    expect(() =>
      resolveOrderItems([{ productId: 'p-plain', quantity: 1 }], [plain]),
    ).not.toThrow();
  });
});

describe('initialStatusForMode', () => {
  it('opens a human_approval order as pending_approval', () => {
    expect(initialStatusForMode('human_approval')).toBe('pending_approval');
  });

  it('opens an auto order as confirmed', () => {
    expect(initialStatusForMode('auto')).toBe('confirmed');
  });
});

describe('isOrderable', () => {
  it('compares a counted stock against the quantity', () => {
    expect(isOrderable({ stock: 3, stockStatus: 'in_stock' }, 3)).toBe(true);
    expect(isOrderable({ stock: 3, stockStatus: 'in_stock' }, 4)).toBe(false);
    expect(isOrderable({ stock: 0, stockStatus: 'in_stock' }, 1)).toBe(false);
  });

  it('treats a pre-order product as orderable whatever its counted stock', () => {
    expect(isOrderable({ stock: 0, stockStatus: 'pre_order' }, 1)).toBe(true);
    expect(isOrderable({ stock: 0, stockStatus: 'pre_order' }, 5)).toBe(true);
  });

  it('treats an untracked stock as orderable unless marked out of stock', () => {
    expect(isOrderable({ stock: null, stockStatus: 'in_stock' }, 999)).toBe(
      true,
    );
    expect(isOrderable({ stock: null, stockStatus: 'pre_order' }, 1)).toBe(
      true,
    );
    expect(isOrderable({ stock: null, stockStatus: 'out_of_stock' }, 1)).toBe(
      false,
    );
  });
});
