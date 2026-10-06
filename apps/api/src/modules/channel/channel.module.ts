// Channel (Feature 16): the channel-agnostic layer every other module talks
// to instead of talking to a specific provider.
//
// This module owns no I/O. It owns two lookups — `ChannelRegistry` (channel
// -> adapter) and `ChannelPolicyRegistry` (channel -> messaging-window
// rules) — plus WhatsApp's translation onto the shared port. That is the
// whole mechanism behind Feature 16's exit criterion: `WebhookModule` and
// the respond path resolve a binding from data instead of branching on a
// channel name, and `AgentModule` never learns a channel exists at all.
//
// It composes OVER WhatsappModule and MetaChannelModule, never the reverse.
// Those modules provide bindings; this one indexes them. That direction is
// what keeps the module graph acyclic and is why the adapters reach the port
// by file path rather than by importing this module.
import { Module } from '@nestjs/common';
import { CoreModule } from '../core';
import {
  META_CHANNEL_ADAPTERS,
  MetaChannelModule,
} from '../meta-channel/meta-channel.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { CHANNEL_ADAPTERS, ChannelRegistry } from './channel-registry.service';
import { ChannelPolicyRegistry } from './channel-policy.registry';
import {
  InstagramChannelPolicy,
  MessengerChannelPolicy,
} from './policies/meta-social-channel.policy';
import { WebChannelPolicy } from './policies/web-channel.policy';
import { WhatsappChannelPolicy } from './policies/whatsapp-channel.policy';
import { ChannelAdapter } from './ports/channel-adapter.port';
import { WebChannelAdapter } from './web-channel.adapter';
import { WhatsappChannelAdapter } from './whatsapp-channel.adapter';

// Deliberately NOT `export *` on the port files. `ChannelAdapter` and
// `BspAdapter` share several type NAMES (NormalizedInboundMessage,
// InboundMessageType, ...) by design — they are the same concepts in two
// vocabularies — and re-exporting both through `src/modules/index.ts` would
// make every one of them ambiguous. Callers import a port by path, which also
// makes it obvious at the import line which of the two they are speaking.
export { CHANNELS, DEFAULT_CHANNEL, isChannelKind } from './ports/channel-kind';
export type { ChannelKind } from './ports/channel-kind';
export { ChannelAdapter } from './ports/channel-adapter.port';
export { ChannelPolicy } from './ports/channel-policy.port';
export { ChannelRegistry } from './channel-registry.service';
export {
  ChannelPolicyRegistry,
  UnsupportedChannelError,
} from './channel-policy.registry';
export { WhatsappChannelAdapter } from './whatsapp-channel.adapter';

@Module({
  imports: [CoreModule, WhatsappModule, MetaChannelModule],
  providers: [
    WhatsappChannelAdapter,
    WhatsappChannelPolicy,
    MessengerChannelPolicy,
    InstagramChannelPolicy,
    // Clarly 2.0 S3: the website widget. No dependencies, so it lives here
    // rather than in WidgetModule (which depends on WebhookModule →
    // ChannelModule, and would make a cycle).
    WebChannelPolicy,
    WebChannelAdapter,
    ChannelPolicyRegistry,
    {
      provide: CHANNEL_ADAPTERS,
      // WhatsApp is always present — it is bound to whatever BSP_PROVIDER
      // selected, including the fail-closed no-op, so there is always exactly
      // one WhatsApp binding. The Meta list is empty unless
      // META_SOCIAL_CHANNELS_ENABLED, which is how a deployment still waiting
      // on Meta Tech Provider approval runs this code without half-binding an
      // unconfigured app.
      useFactory: (
        whatsapp: WhatsappChannelAdapter,
        meta: ChannelAdapter[],
        web: WebChannelAdapter,
      ): ChannelAdapter[] => [whatsapp, ...meta, web],
      inject: [
        WhatsappChannelAdapter,
        META_CHANNEL_ADAPTERS,
        WebChannelAdapter,
      ],
    },
    ChannelRegistry,
  ],
  exports: [ChannelRegistry, ChannelPolicyRegistry, WhatsappChannelAdapter],
})
export class ChannelModule {}
