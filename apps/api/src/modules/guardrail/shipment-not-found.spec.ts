import { trackOrderFoundNothing } from './shipment-not-found';

const NOT_FOUND = JSON.stringify({
  shipments: [],
  message: 'No shipment found for this customer',
  guidance: 'escalate',
});
const FOUND = JSON.stringify({
  shipments: [{ status: 'in_transit', estimatedDeliveryAt: null }],
  guidance: 'quote it',
});

describe('trackOrderFoundNothing() — commerce-tracking#14, missed 3/3 in cycle 3b', () => {
  it('is true when the turn tracked an order and no shipment came back', () => {
    expect(trackOrderFoundNothing([NOT_FOUND])).toBe(true);
  });

  it('is false when any track_order call of the turn found a shipment', () => {
    expect(trackOrderFoundNothing([NOT_FOUND, FOUND])).toBe(false);
    expect(trackOrderFoundNothing([FOUND])).toBe(false);
  });

  it('ignores results of other tools (a lookup, an order)', () => {
    expect(
      trackOrderFoundNothing([JSON.stringify({ products: [] })]),
    ).toBe(false);
    expect(trackOrderFoundNothing([JSON.stringify({ status: 'pending' })])).toBe(
      false,
    );
  });

  it('is false with no tool evidence or unparseable evidence', () => {
    expect(trackOrderFoundNothing([])).toBe(false);
    expect(trackOrderFoundNothing(['not json'])).toBe(false);
  });
});
