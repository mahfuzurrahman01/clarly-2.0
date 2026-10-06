// F25 D9: exhaustive over the status enum, both directions. A transition map
// that is only tested on its happy path is a map that quietly gains an illegal
// edge the first time someone adds a status.
import { ORDER_STATUSES } from '../persistence/drizzle/orders.table';
import {
  allowedTransitionsFrom,
  canTransition,
  InvalidOrderTransitionError,
  isTerminalOrderStatus,
  TERMINAL_ORDER_STATUSES,
} from './order-status-transition';

describe('order-status-transition', () => {
  const ALLOWED: ReadonlyArray<[string, string]> = [
    ['pending_approval', 'confirmed'],
    ['pending_approval', 'rejected'],
    ['pending_approval', 'expired'],
    ['confirmed', 'fulfilled'],
    ['confirmed', 'cancelled'],
    ['confirmed', 'failed'],
  ];

  it.each(ALLOWED)('allows %s -> %s', (from, to) => {
    expect(
      canTransition(
        from as (typeof ORDER_STATUSES)[number],
        to as (typeof ORDER_STATUSES)[number],
      ),
    ).toBe(true);
  });

  it('rejects every pair that is not on the allow-list (exhaustive over the enum)', () => {
    const allowed = new Set(ALLOWED.map(([from, to]) => `${from}->${to}`));

    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const expected = allowed.has(`${from}->${to}`);
        expect({ from, to, allowed: canTransition(from, to) }).toEqual({
          from,
          to,
          allowed: expected,
        });
      }
    }
  });

  it('never allows a self-transition (a re-approve is a 409, not a no-op success)', () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('treats exactly the five terminal statuses as terminal, and gives them no outgoing edges', () => {
    expect([...TERMINAL_ORDER_STATUSES].sort()).toEqual(
      ['cancelled', 'expired', 'failed', 'fulfilled', 'rejected'].sort(),
    );

    for (const status of ORDER_STATUSES) {
      if (isTerminalOrderStatus(status)) {
        expect(allowedTransitionsFrom(status)).toEqual([]);
      } else {
        expect(allowedTransitionsFrom(status).length).toBeGreaterThan(0);
      }
    }
  });

  it('never lets an order leave a terminal status', () => {
    for (const from of TERMINAL_ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('covers every status in the enum — a new status must be classified here, not silently unreachable', () => {
    for (const status of ORDER_STATUSES) {
      expect(Array.isArray(allowedTransitionsFrom(status))).toBe(true);
    }
  });

  describe('InvalidOrderTransitionError', () => {
    it('names both statuses and what would have been allowed', () => {
      const error = new InvalidOrderTransitionError('confirmed', 'rejected');
      expect(error.name).toBe('InvalidOrderTransitionError');
      expect(error.from).toBe('confirmed');
      expect(error.to).toBe('rejected');
      expect(error.message).toContain('confirmed');
      expect(error.message).toContain('rejected');
      expect(error.message).toContain('fulfilled');
    });

    it('says so explicitly when the source status is terminal', () => {
      const error = new InvalidOrderTransitionError('expired', 'confirmed');
      expect(error.message).toContain('terminal');
    });
  });
});
