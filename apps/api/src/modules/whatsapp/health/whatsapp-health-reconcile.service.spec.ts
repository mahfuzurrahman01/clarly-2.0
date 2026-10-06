// Gulf T5 (D5): the daily reconcile sweep.
import type { AppLoggerService, Clock } from '../../core';
import { MetaGraphError } from '../../meta-graph/meta-graph.module';
import type { BspCredentialsService } from '../bsp-credentials.service';
import { CONNECTION_REASONS } from './connection-state.policy';
import type { MetaPhoneNumberHealthReader } from './meta-phone-number-health.reader';
import { WhatsappHealthReconcileService } from './whatsapp-health-reconcile.service';
import type {
  WhatsappHealthSnapshot,
  WhatsappNumberHealthStore,
} from './whatsapp-number-health.store';

const NOW = new Date('2026-09-19T03:00:00Z');

function snapshot(
  overrides: Partial<WhatsappHealthSnapshot> = {},
): WhatsappHealthSnapshot {
  return {
    qualityRating: 'GREEN',
    messagingLimitTier: 'TIER_250',
    nameStatus: 'APPROVED',
    messagingHealth: 'AVAILABLE',
    healthIssues: [],
    displayPhoneNumber: '15550001111',
    verifiedName: 'Lucky Shrub',
    paymentMethodAttached: true,
    wabaAccountReviewStatus: 'APPROVED',
    businessVerificationStatus: 'verified',
    checkedAt: NOW,
    ...overrides,
  };
}

function makeHarness(targets = [{ tenantId: 't-1', phoneNumberId: 'pn-1' }]) {
  const store = {
    listReconcileTargets: jest.fn().mockResolvedValue(targets),
    recordHealthCheck: jest.fn().mockResolvedValue(undefined),
    transitionByPhoneNumberId: jest.fn().mockResolvedValue([]),
  };
  const credentials = {
    getCredential: jest.fn((_pn: string, key: string) =>
      Promise.resolve(key === 'accessToken' ? 'tok' : 'waba-1'),
    ),
  };
  const reader = { read: jest.fn().mockResolvedValue(snapshot()) };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const clock = { now: () => NOW };
  const service = new WhatsappHealthReconcileService(
    store as unknown as WhatsappNumberHealthStore,
    credentials as unknown as BspCredentialsService,
    reader as unknown as MetaPhoneNumberHealthReader,
    clock as unknown as Clock,
    logger as unknown as AppLoggerService,
  );
  return { service, store, credentials, reader, logger };
}

describe('WhatsappHealthReconcileService', () => {
  it('reads each number with its own token, records the snapshot and backfills the WABA id', async () => {
    const { service, store, reader } = makeHarness();

    const summary = await service.reconcileAll();

    expect(reader.read).toHaveBeenCalledWith('pn-1', 'waba-1', 'tok', NOW);
    expect(store.recordHealthCheck).toHaveBeenCalledWith(
      'pn-1',
      snapshot(),
      'waba-1',
    );
    expect(summary).toEqual({
      checked: 1,
      restricted: 0,
      reconnectRequired: 0,
      failed: 0,
    });
  });

  it('restores a number Meta now reports as able to send, from restricted only', async () => {
    const { service, store } = makeHarness();
    await service.reconcileAll();
    expect(store.transitionByPhoneNumberId).toHaveBeenCalledWith('pn-1', {
      kind: 'restore',
      from: ['restricted'],
    });
  });

  it("restricts a BLOCKED number with Meta's own description and fix (e.g. payment method)", async () => {
    const { service, store, reader } = makeHarness();
    reader.read.mockResolvedValue(
      snapshot({
        messagingHealth: 'BLOCKED',
        healthIssues: [
          {
            entityType: 'WABA',
            severity: 'BLOCKED',
            errorCode: 141006,
            description: 'There is an error with the payment method',
            possibleSolution: 'Add a valid payment method in WhatsApp Manager.',
          },
        ],
      }),
    );
    store.transitionByPhoneNumberId.mockResolvedValue([
      { tenantId: 't-1', phoneNumberId: 'pn-1', connectionState: 'restricted' },
    ]);

    const summary = await service.reconcileAll();

    expect(store.transitionByPhoneNumberId).toHaveBeenCalledWith('pn-1', {
      kind: 'degrade',
      to: 'restricted',
      reason:
        'Meta is blocking messages from this number: There is an error with the payment method. Add a valid payment method in WhatsApp Manager.',
    });
    expect(summary.restricted).toBe(1);
  });

  it('does not touch the state when Meta gave no health status', async () => {
    const { service, store, reader } = makeHarness();
    reader.read.mockResolvedValue(snapshot({ messagingHealth: null }));
    await service.reconcileAll();
    expect(store.transitionByPhoneNumberId).not.toHaveBeenCalled();
  });

  it('moves a number whose token Meta rejects to reconnect_required and records no check', async () => {
    const { service, store, reader } = makeHarness();
    reader.read.mockRejectedValue(new MetaGraphError(401, 190, 460, 'expired'));
    store.transitionByPhoneNumberId.mockResolvedValue([
      {
        tenantId: 't-1',
        phoneNumberId: 'pn-1',
        connectionState: 'reconnect_required',
      },
    ]);

    const summary = await service.reconcileAll();

    expect(store.transitionByPhoneNumberId).toHaveBeenCalledWith('pn-1', {
      kind: 'degrade',
      to: 'reconnect_required',
      reason: CONNECTION_REASONS.tokenRevoked,
    });
    expect(store.recordHealthCheck).not.toHaveBeenCalled();
    expect(summary.reconnectRequired).toBe(1);
  });

  it('keeps going past one failing number and counts it', async () => {
    const { service, store, reader, logger } = makeHarness([
      { tenantId: 't-1', phoneNumberId: 'pn-1' },
      { tenantId: 't-2', phoneNumberId: 'pn-2' },
    ]);
    reader.read
      .mockRejectedValueOnce(new MetaGraphError(500, 2, null, 'Meta down'))
      .mockResolvedValueOnce(snapshot());

    const summary = await service.reconcileAll();

    expect(summary).toMatchObject({ checked: 1, failed: 1 });
    expect(store.recordHealthCheck).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('pn-1'),
      expect.any(String),
    );
  });

  it('still checks a legacy row with no wabaId in its credentials', async () => {
    const { service, store, credentials } = makeHarness();
    credentials.getCredential.mockImplementation((_pn, key) =>
      key === 'accessToken'
        ? Promise.resolve('tok')
        : Promise.reject(new Error('no wabaId')),
    );
    await service.reconcileAll();
    expect(store.recordHealthCheck).toHaveBeenCalledWith(
      'pn-1',
      expect.anything(),
      null,
    );
  });
});
