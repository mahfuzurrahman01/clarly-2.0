import {
  CUSTOMER_SERVICE_WINDOW_HOURS,
  customerServiceWindow,
} from './customer-service-window';

const LAST_INBOUND = new Date('2026-08-18T00:00:00Z');
const hoursAfter = (hours: number) =>
  new Date(LAST_INBOUND.getTime() + hours * 60 * 60 * 1000);

describe('customerServiceWindow()', () => {
  it('is open immediately after an inbound message', () => {
    expect(customerServiceWindow(LAST_INBOUND, LAST_INBOUND).open).toBe(true);
  });

  it('is open just inside the window and shut just outside it', () => {
    expect(customerServiceWindow(LAST_INBOUND, hoursAfter(23.9)).open).toBe(
      true,
    );
    expect(customerServiceWindow(LAST_INBOUND, hoursAfter(24.1)).open).toBe(
      false,
    );
  });

  it('treats the exact boundary as shut — Meta rejects at 24h, so the honest answer at the edge is "no"', () => {
    expect(
      customerServiceWindow(
        LAST_INBOUND,
        hoursAfter(CUSTOMER_SERVICE_WINDOW_HOURS),
      ).open,
    ).toBe(false);
  });

  it('reports when the window shuts, whether or not it is already shut', () => {
    const expected = hoursAfter(CUSTOMER_SERVICE_WINDOW_HOURS);
    expect(customerServiceWindow(LAST_INBOUND, LAST_INBOUND).expiresAt).toEqual(
      expected,
    );
    expect(
      customerServiceWindow(LAST_INBOUND, hoursAfter(48)).expiresAt,
    ).toEqual(expected);
  });
});
