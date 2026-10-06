// Gulf T5 (D5): WABA health webhook events -> store writes.
import type { AppConfigService, AppLoggerService } from '../../core';
import { CONNECTION_REASONS } from './connection-state.policy';
import { WabaHealthWebhookService } from './waba-health-webhook.service';
import type { WhatsappNumberHealthStore } from './whatsapp-number-health.store';

function makeHarness() {
  const store = {
    transitionByWaba: jest.fn().mockResolvedValue([
      {
        tenantId: 't-1',
        phoneNumberId: 'pn-1',
        connectionState: 'disconnected',
      },
    ]),
    setMessagingLimitForWaba: jest.fn().mockResolvedValue(2),
    setNameStatus: jest.fn().mockResolvedValue(1),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new WabaHealthWebhookService(
    store as unknown as WhatsappNumberHealthStore,
    { metaAppId: 'app-1' } as unknown as AppConfigService,
    logger as unknown as AppLoggerService,
  );
  return { service, store, logger };
}

function body(field: string, value: unknown, entryId = 'waba-1') {
  return Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: entryId, changes: [{ field, value }] }],
    }),
  );
}

describe('WabaHealthWebhookService', () => {
  it('applies an account_update transition to every number on the WABA and warns per degraded number', async () => {
    const { service, store, logger } = makeHarness();
    await service.apply(body('account_update', { event: 'ACCOUNT_DELETED' }));

    expect(store.transitionByWaba).toHaveBeenCalledWith('waba-1', {
      kind: 'degrade',
      to: 'disconnected',
      reason: CONNECTION_REASONS.wabaDeleted,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('pn-1'),
      expect.any(String),
    );
  });

  it('checks PARTNER_APP_UNINSTALLED against our configured app id', async () => {
    const { service, store } = makeHarness();
    await service.apply(
      body('account_update', {
        event: 'PARTNER_APP_UNINSTALLED',
        waba_info: { waba_id: 'waba-9', partner_app_id: 'someone-else' },
      }),
    );
    expect(store.transitionByWaba).not.toHaveBeenCalled();

    await service.apply(
      body('account_update', {
        event: 'PARTNER_APP_UNINSTALLED',
        waba_info: { waba_id: 'waba-9', partner_app_id: 'app-1' },
      }),
    );
    expect(store.transitionByWaba).toHaveBeenCalledWith(
      'waba-9',
      expect.objectContaining({ to: 'reconnect_required' }),
    );
  });

  it('stores a messaging-limit change on every number of the WABA', async () => {
    const { service, store } = makeHarness();
    await service.apply(
      body('phone_number_quality_update', {
        display_phone_number: '15550783881',
        event: 'UPGRADE',
        max_daily_conversations_per_business: 'TIER_10K',
      }),
    );
    expect(store.setMessagingLimitForWaba).toHaveBeenCalledWith(
      'waba-1',
      'TIER_10K',
    );
  });

  it('stores a display-name decision on the matching number', async () => {
    const { service, store } = makeHarness();
    await service.apply(
      body('phone_number_name_update', {
        display_phone_number: '15550783881',
        decision: 'REJECTED',
        rejection_reason: 'NAME_FORMAT_UNACCEPTABLE',
      }),
    );
    expect(store.setNameStatus).toHaveBeenCalledWith(
      'waba-1',
      '15550783881',
      'DECLINED',
    );
  });

  it('does nothing for an ordinary messages webhook', async () => {
    const { service, store } = makeHarness();
    await service.apply(
      body('messages', { metadata: { phone_number_id: '1' }, messages: [] }),
    );
    expect(store.transitionByWaba).not.toHaveBeenCalled();
    expect(store.setMessagingLimitForWaba).not.toHaveBeenCalled();
    expect(store.setNameStatus).not.toHaveBeenCalled();
  });

  it('logs and continues past a failing write so later events in the batch still apply', async () => {
    const { service, store, logger } = makeHarness();
    store.transitionByWaba.mockRejectedValueOnce(new Error('db down'));
    const raw = Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'waba-1',
            changes: [
              { field: 'account_update', value: { event: 'ACCOUNT_DELETED' } },
              {
                field: 'phone_number_quality_update',
                value: { event: 'UPGRADE', current_limit: 'TIER_2K' },
              },
            ],
          },
        ],
      }),
    );
    await expect(service.apply(raw)).rejects.toThrow('db down');
    expect(store.setMessagingLimitForWaba).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
