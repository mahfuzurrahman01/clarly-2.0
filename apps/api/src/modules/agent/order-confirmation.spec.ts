import {
  buildOrderConfirmation,
  findCreatedOrders,
} from './order-confirmation';

const PENDING = {
  status: 'pending_approval',
  orderReference: 'ORD-77',
  total: '598.00',
  currency: 'SAR',
  items: [
    { name: 'Kettle', quantity: 2, unitPrice: '99.00' },
    { name: 'Tent', quantity: 1, unitPrice: '400.00' },
  ],
  customerMessage: 'not_yet_placed_awaiting_merchant_confirmation',
  duplicate: false,
};

describe('findCreatedOrders', () => {
  it('reads a successful create_order result', () => {
    expect(findCreatedOrders([JSON.stringify(PENDING)])).toHaveLength(1);
  });

  it.each([
    ['a refusal', { status: 'refused', reason: 'unknown_product' }],
    [
      'a track_order result',
      { shipments: [{ orderReference: 'ORD-1', status: 'in_transit' }] },
    ],
    ['a lookup result', { products: [] }],
  ])('ignores %s', (_label, output) => {
    expect(findCreatedOrders([JSON.stringify(output)])).toEqual([]);
  });

  it('ignores unparseable evidence and de-duplicates a re-read order', () => {
    const evidence = [
      'not json',
      JSON.stringify(PENDING),
      JSON.stringify({ ...PENDING, duplicate: true }),
    ];
    expect(findCreatedOrders(evidence)).toHaveLength(1);
  });
});

describe('buildOrderConfirmation', () => {
  it('returns null when no order was written this turn', () => {
    expect(
      buildOrderConfirmation(['{"status":"refused"}'], 'confirm please'),
    ).toBeNull();
    expect(buildOrderConfirmation([], 'confirm please')).toBeNull();
  });

  it('states reference, every item with its quantity, and the total for a pending order', () => {
    const text = buildOrderConfirmation([JSON.stringify(PENDING)], 'yes');
    expect(text).toContain('ORD-77');
    expect(text).toContain('2 × Kettle (99.00 SAR)');
    expect(text).toContain('1 × Tent (400.00 SAR)');
    expect(text).toContain('598.00 SAR');
    expect(text).toMatch(/waiting for our team to confirm/);
    expect(text).not.toMatch(/placed|paid|shipped/i);
  });

  it('says placed only for a confirmed order', () => {
    const text = buildOrderConfirmation(
      [JSON.stringify({ ...PENDING, status: 'confirmed' })],
      'yes',
    );
    expect(text).toContain('is placed');
    expect(text).not.toMatch(/waiting for our team/);
  });

  it('still names the reference when the row carries no items or total', () => {
    const text = buildOrderConfirmation(
      [JSON.stringify({ status: 'confirmed', orderReference: 'ORD-9' })],
      'yes',
    );
    expect(text).toBe('Your order ORD-9 is placed.');
  });

  it('uses the Arabic wording for an Arabic message', () => {
    const text = buildOrderConfirmation([JSON.stringify(PENDING)], 'أكد الطلب');
    expect(text).toContain('ORD-77');
    expect(text).toContain('بانتظار تأكيد فريقنا');
    expect(text).toContain('598.00 SAR');
  });

  it('confirms every order written in the turn', () => {
    const text = buildOrderConfirmation(
      [
        JSON.stringify(PENDING),
        JSON.stringify({ ...PENDING, orderReference: 'ORD-78' }),
      ],
      'yes',
    );
    expect(text).toContain('ORD-77');
    expect(text).toContain('ORD-78');
  });
});
