// Gulf T7 (D7): the Deauthorize callback's decision logic. Cross-tenant
// isolation of the actual UPDATE is proven against Postgres in
// test/integration/meta-privacy.integration-spec.ts.
import type { AppLoggerService } from '../core';
import type { SocialChannelCredentialsService } from '../meta-channel/social-channel-credentials.service';
import {
  CONNECTION_REASONS,
  type WhatsappNumberHealthStore,
} from '../whatsapp/whatsapp.module';
import {
  DEAUTHORIZED_REASON,
  MetaDeauthorizeService,
} from './meta-deauthorize.service';

function makeHarness(
  affected: { tenantId: string; channelAccountId: string }[],
  numbers: { tenantId: string; phoneNumberId: string }[] = [],
) {
  const markReconnectRequiredForMetaUser = jest
    .fn()
    .mockResolvedValue(affected);
  const transitionByMetaUser = jest
    .fn()
    .mockResolvedValue(
      numbers.map((n) => ({ ...n, connectionState: 'reconnect_required' })),
    );
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new MetaDeauthorizeService(
    {
      markReconnectRequiredForMetaUser,
    } as unknown as SocialChannelCredentialsService,
    { transitionByMetaUser } as unknown as WhatsappNumberHealthStore,
    logger as unknown as AppLoggerService,
  );
  return {
    service,
    markReconnectRequiredForMetaUser,
    transitionByMetaUser,
    logger,
  };
}

describe('MetaDeauthorizeService', () => {
  it('degrades exactly the channels that user connected, with a reason the tenant can act on', async () => {
    const { service, markReconnectRequiredForMetaUser, logger } = makeHarness([
      { tenantId: 't-1', channelAccountId: 'page-1' },
      { tenantId: 't-2', channelAccountId: 'ig-2' },
    ]);

    const outcome = await service.handle({ userId: '4242', issuedAt: null });

    expect(markReconnectRequiredForMetaUser).toHaveBeenCalledTimes(1);
    expect(markReconnectRequiredForMetaUser).toHaveBeenCalledWith(
      '4242',
      DEAUTHORIZED_REASON,
    );
    expect(outcome).toEqual({
      socialChannelsDegraded: 2,
      whatsappNumbersDegraded: 0,
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('is a clean no-op for a user who connected nothing (e.g. only ever logged in)', async () => {
    const { service } = makeHarness([]);
    await expect(
      service.handle({ userId: '4242', issuedAt: null }),
    ).resolves.toEqual({
      socialChannelsDegraded: 0,
      whatsappNumbersDegraded: 0,
    });
  });

  it('Gulf T5: moves the WhatsApp numbers that user connected to reconnect_required', async () => {
    const { service, transitionByMetaUser, logger } = makeHarness(
      [],
      [
        { tenantId: 't-1', phoneNumberId: 'pn-1' },
        { tenantId: 't-3', phoneNumberId: 'pn-3' },
      ],
    );

    const outcome = await service.handle({ userId: '4242', issuedAt: null });

    expect(transitionByMetaUser).toHaveBeenCalledWith('4242', {
      kind: 'degrade',
      to: 'reconnect_required',
      reason: CONNECTION_REASONS.deauthorized,
    });
    expect(outcome).toEqual({
      socialChannelsDegraded: 0,
      whatsappNumbersDegraded: 2,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('pn-3'),
      expect.any(String),
    );
  });

  it('never writes the Meta user id to the logs', async () => {
    const { service, logger } = makeHarness(
      [{ tenantId: 't-1', channelAccountId: 'page-1' }],
      [{ tenantId: 't-1', phoneNumberId: 'pn-1' }],
    );
    await service.handle({ userId: '987654321', issuedAt: null });

    const logged = JSON.stringify([
      logger.log.mock.calls,
      logger.warn.mock.calls,
    ]);
    expect(logged).not.toContain('987654321');
  });
});
