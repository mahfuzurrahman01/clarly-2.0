// Channel (ChannelModule, Feature 16): channel -> ChannelPolicy lookup.
//
// A Map built once from the injected policies, not a switch. The difference
// matters: a switch would have to be edited (and could be forgotten) in
// every caller that grows a channel, whereas an unregistered channel here
// throws loudly at the single place that resolves one.
import { Injectable } from '@nestjs/common';
import type { ChannelKind } from './ports/channel-kind';
import { ChannelPolicy } from './ports/channel-policy.port';
import {
  InstagramChannelPolicy,
  MessengerChannelPolicy,
} from './policies/meta-social-channel.policy';
import { WebChannelPolicy } from './policies/web-channel.policy';
import { WhatsappChannelPolicy } from './policies/whatsapp-channel.policy';

/** Thrown when something asks for a channel nothing implements — a wiring bug, surfaced rather than defaulted to WhatsApp's rules. */
export class UnsupportedChannelError extends Error {
  constructor(channel: string) {
    super(
      `No channel policy or adapter is registered for channel "${channel}".`,
    );
    this.name = 'UnsupportedChannelError';
  }
}

@Injectable()
export class ChannelPolicyRegistry {
  private readonly policies: ReadonlyMap<ChannelKind, ChannelPolicy>;

  constructor(
    whatsapp: WhatsappChannelPolicy,
    messenger: MessengerChannelPolicy,
    instagram: InstagramChannelPolicy,
    web: WebChannelPolicy,
  ) {
    this.policies = new Map<ChannelKind, ChannelPolicy>(
      [whatsapp, messenger, instagram, web].map((policy) => [
        policy.channel,
        policy,
      ]),
    );
  }

  for(channel: ChannelKind): ChannelPolicy {
    const policy = this.policies.get(channel);
    if (!policy) throw new UnsupportedChannelError(channel);
    return policy;
  }
}
