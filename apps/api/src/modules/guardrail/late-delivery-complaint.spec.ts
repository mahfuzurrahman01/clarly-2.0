import {
  isLateDeliveryComplaint,
  OVERDUE_AFTER_MS,
  reportsLateDelivery,
  shipmentShowsProblem,
} from './late-delivery-complaint';

const NOW = Date.parse('2026-09-30T08:00:00Z');

function trackOrder(
  status: string,
  estimatedDeliveryAt: string | null,
): string {
  return JSON.stringify({
    shipments: [
      {
        orderReference: 'ORD-YHJYMW',
        trackingNumber: 'AWB-C-9004',
        courier: 'J&T',
        status,
        statusAt: '2026-09-30T07:21:11.020Z',
        estimatedDeliveryAt,
        lastLocation: null,
      },
    ],
    guidance: 'These rows are the only source of delivery information.',
  });
}

describe('reportsLateDelivery()', () => {
  it.each([
    // commerce-complaint#6 and #8, verbatim.
    'طلبيتي رقم AWB-C-9004 متأخرة كثير عن الموعد المتوقع، ليش صارت هالمدة؟',
    'بعد ما توصل شحنتي؟ كانت لازم توصل قبل يومين ولين الحين ماوصلت.',
    'شحنتي رقم AWB-100-2004 متأخرة على غير العادة، شو الوضع؟',
    'تأخرت الشحنة كثير',
    'لسه ما وصل الطلب',
    'This is the second time your courier is late',
    'My order is taking forever, tracking number AWB-100-2004',
    'it still has not arrived',
    'it should have arrived two days ago',
    'my parcel is overdue',
    'talabi mit2akhar jiddan',
    'el shehna mota2akhra',
    'el talab ma wasal ba3d',
  ])('detects %s', (message) => {
    expect(reportsLateDelivery(message)).toBe(true);
  });

  it.each([
    'Hi, can you check the status of tracking number AWB-100-2002?',
    'where is my order AWB-100-2003',
    'hala, momken tcheck lail order AWB-100-2003, wain wasal?',
    'السلام عليكم، ممكن تتأكد من حالة الشحنة اللي رقمها AWB-100-2001؟',
    'when will it arrive',
    'hi',
  ])('ignores the plain status question %s', (message) => {
    expect(reportsLateDelivery(message)).toBe(false);
  });
});

describe('shipmentShowsProblem()', () => {
  it('flags an undelivered shipment whose estimated date passed by a day or more (commerce-complaint#6: 8 days)', () => {
    expect(
      shipmentShowsProblem(
        [trackOrder('out_for_delivery', '2026-09-22T00:00:00.000Z')],
        NOW,
      ),
    ).toBe(true);
  });

  it('does not flag a shipment still inside its estimated day', () => {
    const eta = new Date(NOW - OVERDUE_AFTER_MS + 60_000).toISOString();

    expect(shipmentShowsProblem([trackOrder('in_transit', eta)], NOW)).toBe(
      false,
    );
  });

  it('flags a problem status even without an estimated date', () => {
    expect(shipmentShowsProblem([trackOrder('exception', null)], NOW)).toBe(
      true,
    );
    expect(
      shipmentShowsProblem([trackOrder('failed_attempt', null)], NOW),
    ).toBe(true);
  });

  it.each(['delivered', 'returned', 'cancelled'])(
    'never flags a %s shipment, however old its estimate',
    (status) => {
      expect(
        shipmentShowsProblem(
          [trackOrder(status, '2026-09-01T00:00:00.000Z')],
          NOW,
        ),
      ).toBe(false);
    },
  );

  it('ignores evidence that is not a track_order result', () => {
    expect(
      shipmentShowsProblem(
        [
          JSON.stringify({ orderReference: 'ORD-1', status: 'confirmed' }),
          JSON.stringify({ products: [] }),
          'not json',
        ],
        NOW,
      ),
    ).toBe(false);
  });

  it('ignores an unparseable estimated date', () => {
    expect(shipmentShowsProblem([trackOrder('in_transit', 'soon')], NOW)).toBe(
      false,
    );
  });
});

describe('isLateDeliveryComplaint()', () => {
  const overdue = [trackOrder('out_for_delivery', '2026-09-22T00:00:00.000Z')];

  it('needs both the customer saying it is late and a shipment that shows it', () => {
    expect(
      isLateDeliveryComplaint('طلبيتي متأخرة كثير عن الموعد', overdue, NOW),
    ).toBe(true);
  });

  it('does not fire on a plain status question about an overdue shipment', () => {
    expect(
      isLateDeliveryComplaint('where is my order AWB-C-9004', overdue, NOW),
    ).toBe(false);
  });

  it('does not fire when no shipment shows a problem', () => {
    expect(
      isLateDeliveryComplaint(
        'my order is late',
        [trackOrder('in_transit', '2026-10-02T00:00:00.000Z')],
        NOW,
      ),
    ).toBe(false);
  });

  it('does not fire without any tool evidence (the model has nothing to confirm it against)', () => {
    expect(isLateDeliveryComplaint('my order is late', [], NOW)).toBe(false);
  });
});
