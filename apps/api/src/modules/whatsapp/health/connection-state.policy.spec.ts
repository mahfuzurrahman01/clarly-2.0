// Gulf T5 (D5): the connection-state transition rules every health writer
// (send path, WABA webhooks, deauthorize, daily reconcile) goes through.
import {
  CONNECTION_REASONS,
  applyTransition,
  degrade,
  restore,
} from './connection-state.policy';

const active = { connectionState: 'active', connectionError: null } as const;
const restricted = {
  connectionState: 'restricted',
  connectionError: 'restricted by Meta',
} as const;
const reconnect = {
  connectionState: 'reconnect_required',
  connectionError: 'register failed',
} as const;
const disconnected = {
  connectionState: 'disconnected',
  connectionError: 'WABA deleted',
} as const;

describe('connection-state policy', () => {
  describe('degrade', () => {
    it('moves an active number to the degraded state with the reason', () => {
      expect(
        applyTransition(
          active,
          degrade('reconnect_required', CONNECTION_REASONS.tokenRevoked),
        ),
      ).toEqual({
        connectionState: 'reconnect_required',
        connectionError: CONNECTION_REASONS.tokenRevoked,
      });
    });

    it('never softens a more severe state (a restriction does not hide a dead token)', () => {
      expect(
        applyTransition(reconnect, degrade('restricted', 'restricted')),
      ).toBeNull();
      expect(
        applyTransition(
          disconnected,
          degrade('reconnect_required', CONNECTION_REASONS.tokenRevoked),
        ),
      ).toBeNull();
    });

    it('escalates to a more severe state', () => {
      expect(
        applyTransition(restricted, degrade('disconnected', 'gone')),
      ).toEqual({ connectionState: 'disconnected', connectionError: 'gone' });
    });

    it('refreshes the reason at the same severity, and is a no-op when nothing changed', () => {
      expect(
        applyTransition(restricted, degrade('restricted', 'new reason')),
      ).toEqual({
        connectionState: 'restricted',
        connectionError: 'new reason',
      });
      expect(
        applyTransition(
          restricted,
          degrade('restricted', 'restricted by Meta'),
        ),
      ).toBeNull();
    });
  });

  describe('restore', () => {
    it('returns a number to active only from the listed states', () => {
      expect(applyTransition(restricted, restore(['restricted']))).toEqual(
        active,
      );
      expect(applyTransition(reconnect, restore(['restricted']))).toBeNull();
      expect(applyTransition(disconnected, restore(['restricted']))).toBeNull();
    });

    it('is a no-op on an already active number', () => {
      expect(applyTransition(active, restore(['restricted']))).toBeNull();
    });
  });

  it('gives every reason as a tenant-actionable sentence', () => {
    for (const reason of Object.values(CONNECTION_REASONS)) {
      expect(reason).toMatch(/\.$/);
      expect(reason.length).toBeGreaterThan(30);
    }
  });
});
