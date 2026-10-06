// Channel (MetaChannelModule, Feature 16): the Meta Graph binding of the
// shared `ChannelAdapter` port — Facebook Messenger and Instagram DM.
//
// ONE implementation, two bindings. Messenger and Instagram share the Send
// API endpoint (`POST /{page-id}/messages`), the webhook envelope, the
// signature scheme and the token lifecycle; they differ only in which
// out-of-window exceptions they accept, and that difference lives in
// `ChannelPolicy`, not here. So the logic sits in `MetaChannelAdapter` and
// the two concrete classes below add nothing but their `channel` tag, which
// is what `ChannelRegistry` indexes on.
//
// Everything token-related is delegated to `MetaTokenService`, deliberately:
// this class must not grow its own idea of when a token is stale. It asks
// for a usable token and sends; if none can be had, the
// `SocialChannelReconnectRequiredError` propagates to the respond path,
// which turns it into a DELIVERY_FAILURE escalation — a human answers the
// customer. That is the exit criterion's "never silently drop messages",
// implemented as a code path rather than promised in a comment.
import { Injectable } from '@nestjs/common';
import { AppConfigService, AppLoggerService } from '../core';
import {
  ChannelAdapter,
  type InboundMedia,
  type InboundMediaSource,
  type NormalizedInboundMessage,
  type NormalizedStatusUpdate,
  type SendResult,
  type SendTextParams,
} from '../channel/ports/channel-adapter.port';
import type { ChannelKind } from '../channel/ports/channel-kind';
import { MediaRejectedError } from '../channel/ports/media-download.errors';
import {
  findSignatureHeader,
  verifyHmacSha256,
} from '../whatsapp/webhook-signature';
import { MetaGraphClient } from '../meta-graph/meta-graph.module';
import { MetaTokenService } from './meta-token.service';
import {
  parseMetaSocialEnvelope,
  parseMetaSocialStatusUpdates,
} from './meta-social-envelope.parser';
import { SocialChannelResolutionService } from './social-channel-resolution.service';
import { SocialMediaFetcher } from './social-media.fetcher';

const SIGNATURE_HEADER = 'x-hub-signature-256';

@Injectable()
export abstract class MetaChannelAdapter extends ChannelAdapter {
  constructor(
    private readonly config: AppConfigService,
    private readonly graph: MetaGraphClient,
    private readonly tokens: MetaTokenService,
    private readonly channels: SocialChannelResolutionService,
    private readonly logger: AppLoggerService,
    private readonly media: SocialMediaFetcher,
  ) {
    super();
  }

  /**
   * Meta signs with the APP secret, not with any per-tenant credential — one
   * Meta app fronts every page and IG account it owns. Same HMAC helper the
   * WhatsApp adapters use: one signature-comparison implementation to audit,
   * not three.
   */
  verifyWebhookSignature(
    rawBody: string | Buffer,
    headers: Record<string, string>,
  ): boolean {
    if (!this.config.bspWebhookSignatureRequired) {
      this.logger.warn(
        'MetaChannelAdapter: accepting an inbound webhook WITHOUT signature verification (BSP_WEBHOOK_SIGNATURE_REQUIRED=false). Meta always signs; this flag is dev-only and envSchema forbids it under NODE_ENV=production.',
        MetaChannelAdapter.name,
      );
      return true;
    }

    return verifyHmacSha256(
      rawBody,
      findSignatureHeader(headers, SIGNATURE_HEADER),
      this.config.metaAppSecret,
    );
  }

  parseInboundWebhook(rawBody: string | Buffer): NormalizedInboundMessage[] {
    // The parser tags each message with its OWN channel from the envelope's
    // `object` field, so a Messenger payload delivered to the Instagram
    // binding still normalizes as 'messenger'. That is why the two bindings
    // can share one endpoint without either of them branching.
    return parseMetaSocialEnvelope(rawBody);
  }

  parseStatusUpdates(rawBody: string | Buffer): NormalizedStatusUpdate[] {
    return parseMetaSocialStatusUpdates(rawBody);
  }

  /**
   * Meta's subscription handshake, identical in shape to the WhatsApp one but
   * keyed on the social verify token. Fails closed on an unconfigured token:
   * an attacker who passed it would learn only that the endpoint exists, and
   * there is no reason to concede even that.
   */
  verifySubscription(query: Record<string, string>): string | null {
    const verifyToken = this.config.metaVerifyToken;
    if (!verifyToken) return null;

    const {
      'hub.mode': mode,
      'hub.verify_token': token,
      'hub.challenge': challenge,
    } = query;

    if (mode !== 'subscribe' || token !== verifyToken || !challenge) {
      this.logger.warn(
        'MetaChannelAdapter: rejecting a webhook subscription handshake — mode or verify token did not match.',
        MetaChannelAdapter.name,
      );
      return null;
    }
    return challenge;
  }

  /**
   * `channelAccountId` is the id the message ARRIVED on (page id for
   * Messenger, IG account id for Instagram); `pageId` is the id the send goes
   * OUT on. On Instagram they differ, which is why this resolves the row
   * rather than reusing the argument — an Instagram DM sent to the IG account
   * id is rejected by Meta.
   */
  async sendText(params: SendTextParams): Promise<SendResult> {
    const resolved = await this.channels.resolve(params.channelAccountId);
    // Throws SocialChannelReconnectRequiredError when the channel is
    // degraded. Deliberately not caught here: the respond path's delivery
    // check turns it into a human-answered escalation, and swallowing it
    // here would be the silent drop this feature exists to prevent.
    const pageAccessToken = await this.tokens.ensureFreshToken(
      params.channelAccountId,
    );

    const { messageId } = await this.graph.sendMessage({
      pageId: resolved.pageId,
      pageAccessToken,
      recipientId: params.to,
      text: params.body,
      ...(params.tag ? { tag: params.tag } : {}),
    });

    return { providerMessageId: messageId };
  }

  /**
   * Gulf T6 (D9): a Messenger/Instagram attachment is a signed CDN url.
   * Fetched with no credentials (no page token is looked up, so none can
   * reach a CDN host), from the host allowlist only; see SocialMediaFetcher.
   */
  async downloadMedia(
    _channelAccountId: string,
    source: InboundMediaSource,
  ): Promise<InboundMedia> {
    if (source.mediaUrl === undefined) {
      throw new MediaRejectedError(
        'A Messenger/Instagram attachment is fetched by its CDN url; this one carried a media id instead.',
      );
    }
    return this.media.fetch(source.mediaUrl);
  }
}

/** Facebook Messenger binding. Adds only its channel tag — see the class comment above. */
@Injectable()
export class MessengerChannelAdapter extends MetaChannelAdapter {
  readonly channel: ChannelKind = 'messenger';
}

/** Instagram DM binding. Adds only its channel tag. */
@Injectable()
export class InstagramChannelAdapter extends MetaChannelAdapter {
  readonly channel: ChannelKind = 'instagram';
}
