// Channel (WebhookModule, Feature 16 / T6): channel-account-id -> tenant-id,
// for ANY channel.
//
// T6's rule is unchanged and is the reason this exists at all: the tenant is
// resolved BEFORE any tenant-scoped work, from an id on an untrusted payload,
// with no tenant context yet in existence. What Feature 16 changed is that
// there are now two tables that answer that question — `whatsapp_numbers` and
// `social_channels` — because the two have genuinely different columns
// (WABA/template state vs. page id and token lifecycle) and merging them
// would give every WhatsApp row four null Meta columns and vice versa.
//
// So this is a ROUTING TABLE, built once in the constructor, not a branch per
// message. The distinction is the point: `ingest()` stays a straight line
// with no `if (channel === ...)` in it, and a fourth channel is a new entry
// here rather than an edit to the ingest path.
import { Injectable } from '@nestjs/common';
import { SocialChannelResolutionService } from '../meta-channel/social-channel-resolution.service';
import type { ChannelKind } from '../channel/ports/channel-kind';
import { UnknownWhatsappNumberError } from './unknown-whatsapp-number.error';
import {
  UnknownWebWidgetError,
  WebWidgetResolutionService,
} from './web-widget-resolution.service';
import { WhatsappNumberResolutionService } from './whatsapp-number-resolution.service';

/** Thrown when a webhook names an account no tenant has connected, on any channel. Callers map it to 404. */
export class UnknownChannelAccountError extends Error {
  constructor(
    public readonly channel: ChannelKind,
    public readonly channelAccountId: string,
  ) {
    super(
      `No tenant has connected the ${channel} account "${channelAccountId}".`,
    );
    this.name = 'UnknownChannelAccountError';
  }
}

type Resolver = (channelAccountId: string) => Promise<string>;

@Injectable()
export class ChannelTenantResolver {
  private readonly resolvers: ReadonlyMap<ChannelKind, Resolver>;

  constructor(
    whatsapp: WhatsappNumberResolutionService,
    social: SocialChannelResolutionService,
    web: WebWidgetResolutionService,
  ) {
    this.resolvers = new Map<ChannelKind, Resolver>([
      ['whatsapp', (id) => whatsapp.resolveTenantId(id)],
      ['messenger', (id) => social.resolveTenantId(id)],
      ['instagram', (id) => social.resolveTenantId(id)],
      // Clarly 2.0 S3: the website widget (channelAccountId = widget id).
      ['web', (id) => web.resolveTenantId(id)],
    ]);
  }

  /** @throws UnknownChannelAccountError */
  async resolveTenantId(
    channel: ChannelKind,
    channelAccountId: string,
  ): Promise<string> {
    const resolver = this.resolvers.get(channel);
    if (!resolver) {
      throw new UnknownChannelAccountError(channel, channelAccountId);
    }

    try {
      return await resolver(channelAccountId);
    } catch (error) {
      // Both underlying services throw their own channel-specific "unknown"
      // error. They are normalized here so the ingest path — and the
      // controllers above it — have exactly one thing to catch, rather than
      // one per channel, which is precisely the per-channel branching this
      // feature exists to avoid.
      if (
        error instanceof UnknownWhatsappNumberError ||
        error instanceof UnknownWebWidgetError ||
        (error instanceof Error && error.name === 'UnknownSocialChannelError')
      ) {
        throw new UnknownChannelAccountError(channel, channelAccountId);
      }
      throw error;
    }
  }
}
