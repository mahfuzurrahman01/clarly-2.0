// Feature 16: the MetaChannelAdapter send path.
//
// The Graph call itself is behind `MetaGraphClient` (see that file's header
// for why), so these tests exercise the real adapter logic — account
// resolution, the Instagram page-id distinction, token freshness, and the
// reconnect degrade — with the network faked.
import { createHmac } from 'node:crypto';
import { AppConfigService, AppLoggerService } from '../core';
import type { MetaGraphClient } from '../meta-graph/meta-graph.module';
import type { MetaTokenService } from './meta-token.service';
import {
  InstagramChannelAdapter,
  MessengerChannelAdapter,
} from './meta-channel.adapter';
import type { SocialChannelResolutionService } from './social-channel-resolution.service';
import type { SocialMediaFetcher } from './social-media.fetcher';
import { MediaRejectedError } from '../channel/ports/media-download.errors';
import { SocialChannelReconnectRequiredError } from './social-channel.errors';

const config = {
  bspWebhookSignatureRequired: true,
  metaAppSecret: 'app-secret',
  metaVerifyToken: 'verify-me',
} as unknown as AppConfigService;

const logger = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as AppLoggerService;

function makeHarness(options: { pageId?: string } = {}) {
  const sendMessage = jest
    .fn()
    .mockResolvedValue({ messageId: 'mid.outbound.1' });
  const ensureFreshToken = jest.fn().mockResolvedValue('page-token');
  const resolve = jest.fn().mockResolvedValue({
    tenantId: 'tenant-a',
    channel: 'messenger',
    channelAccountId: 'account-1',
    pageId: options.pageId ?? 'account-1',
    connectionState: 'connected',
  });
  const fetchMedia = jest.fn().mockResolvedValue({
    content: Buffer.from('jpeg'),
    mimeType: 'image/jpeg',
  });

  const deps = [
    config,
    { sendMessage } as unknown as MetaGraphClient,
    { ensureFreshToken } as unknown as MetaTokenService,
    { resolve } as unknown as SocialChannelResolutionService,
    logger,
    { fetch: fetchMedia } as unknown as SocialMediaFetcher,
  ] as const;

  return {
    messenger: new MessengerChannelAdapter(...deps),
    instagram: new InstagramChannelAdapter(...deps),
    sendMessage,
    ensureFreshToken,
    resolve,
    fetchMedia,
  };
}

describe('MetaChannelAdapter bindings', () => {
  it('tags each binding with its own channel, so the registry can index them', () => {
    const { messenger, instagram } = makeHarness();
    expect(messenger.channel).toBe('messenger');
    expect(instagram.channel).toBe('instagram');
  });
});

describe('MetaChannelAdapter.sendText()', () => {
  it('sends through the resolved PAGE id, not the account the message arrived on', async () => {
    // The Instagram case, and the one that silently fails in production if
    // you conflate the two ids: an IG DM sent to the IG account id is
    // rejected by Meta.
    const harness = makeHarness({ pageId: 'linked-page-7' });

    const result = await harness.instagram.sendText({
      channelAccountId: 'ig-account-1',
      to: 'IGSID-5',
      body: 'we ship nationwide',
    });

    expect(harness.sendMessage).toHaveBeenCalledWith({
      pageId: 'linked-page-7',
      pageAccessToken: 'page-token',
      recipientId: 'IGSID-5',
      text: 'we ship nationwide',
    });
    expect(result).toEqual({ providerMessageId: 'mid.outbound.1' });
  });

  it('refreshes the token before using it, never after a failed send', async () => {
    const harness = makeHarness();
    await harness.messenger.sendText({
      channelAccountId: 'account-1',
      to: 'PSID-1',
      body: 'hi',
    });
    expect(harness.ensureFreshToken).toHaveBeenCalledWith('account-1');
  });

  it('passes a message tag through when the caller supplies one', async () => {
    const harness = makeHarness();
    await harness.messenger.sendText({
      channelAccountId: 'account-1',
      to: 'PSID-1',
      body: 'about your order',
      tag: 'HUMAN_AGENT',
    });
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'HUMAN_AGENT' }),
    );
  });

  it('propagates a reconnect-required failure instead of swallowing it', async () => {
    // Feature 16's central degrade. The respond path turns this into a
    // DELIVERY_FAILURE escalation so a human answers the customer; catching
    // it here would be the silent drop the feature exists to prevent.
    const harness = makeHarness();
    harness.ensureFreshToken.mockRejectedValue(
      new SocialChannelReconnectRequiredError('account-1', 'token expired'),
    );

    await expect(
      harness.messenger.sendText({
        channelAccountId: 'account-1',
        to: 'PSID-1',
        body: 'hi',
      }),
    ).rejects.toBeInstanceOf(SocialChannelReconnectRequiredError);
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });
});

describe('MetaChannelAdapter.verifySubscription()', () => {
  it('echoes the challenge for a matching verify token', () => {
    const { messenger } = makeHarness();
    expect(
      messenger.verifySubscription({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-me',
        'hub.challenge': 'abc123',
      }),
    ).toBe('abc123');
  });

  it.each([
    ['a wrong token', { 'hub.verify_token': 'nope' }],
    ['a wrong mode', { 'hub.mode': 'unsubscribe' }],
    ['a missing challenge', { 'hub.challenge': '' }],
  ])('fails closed on %s', (_label, override) => {
    const { messenger } = makeHarness();
    expect(
      messenger.verifySubscription({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-me',
        'hub.challenge': 'abc123',
        ...override,
      }),
    ).toBeNull();
  });
});

describe('MetaChannelAdapter.verifyWebhookSignature()', () => {
  const body = '{"object":"page","entry":[]}';
  // Precomputed HMAC-SHA256 of `body` under 'app-secret'.
  const validSignature = createHmac('sha256', 'app-secret')
    .update(body)
    .digest('hex');

  it('accepts a correctly signed body', () => {
    const { messenger } = makeHarness();
    expect(
      messenger.verifyWebhookSignature(body, {
        'x-hub-signature-256': `sha256=${validSignature}`,
      }),
    ).toBe(true);
  });

  it('rejects a tampered body, a wrong signature, and a missing header', () => {
    const { messenger } = makeHarness();
    expect(
      messenger.verifyWebhookSignature(`${body} `, {
        'x-hub-signature-256': `sha256=${validSignature}`,
      }),
    ).toBe(false);
    expect(
      messenger.verifyWebhookSignature(body, {
        'x-hub-signature-256': 'sha256=deadbeef',
      }),
    ).toBe(false);
    expect(messenger.verifyWebhookSignature(body, {})).toBe(false);
  });
});

describe('MetaChannelAdapter.downloadMedia() (Gulf T6, D9)', () => {
  const CDN_URL = 'https://scontent.xx.fbcdn.net/v/photo.jpg?oh=sig';

  it.each(['messenger', 'instagram'] as const)(
    'fetches the %s CDN url through the allowlisted fetcher, with no token lookup',
    async (binding) => {
      const harness = makeHarness();

      const media = await harness[binding].downloadMedia('account-1', {
        mediaUrl: CDN_URL,
      });

      expect(media).toEqual({
        content: Buffer.from('jpeg'),
        mimeType: 'image/jpeg',
      });
      expect(harness.fetchMedia).toHaveBeenCalledWith(CDN_URL);
      // The CDN signature is the credential: no page token is fetched, so none
      // can leak to a CDN host.
      expect(harness.ensureFreshToken).not.toHaveBeenCalled();
    },
  );

  it('refuses a WhatsApp-style media id rather than guessing a url', async () => {
    const harness = makeHarness();

    await expect(
      harness.messenger.downloadMedia('account-1', { mediaId: '12345' }),
    ).rejects.toBeInstanceOf(MediaRejectedError);
    expect(harness.fetchMedia).not.toHaveBeenCalled();
  });
});
