// Channel (ChannelModule, Feature 16): channel -> ChannelAdapter lookup.
//
// This class is what makes the exit criterion "zero channel-specific
// branches in AgentModule" structural rather than aspirational. The respond
// path used to inject a single `BspAdapter` and could only ever reply over
// WhatsApp; it now injects this and asks for the adapter matching the
// channel already recorded on the job. That is a lookup on data, not a
// branch on a channel name — adding a fourth channel adds a provider here
// and changes no caller.
//
// Adapters arrive as an injected array (CHANNEL_ADAPTERS) rather than by
// naming each concrete class, so this file has no dependency on
// MetaChannelModule and the module graph stays acyclic.
import { Inject, Injectable } from '@nestjs/common';
import { UnsupportedChannelError } from './channel-policy.registry';
import { ChannelAdapter } from './ports/channel-adapter.port';
import type { ChannelKind } from './ports/channel-kind';

/** DI token for "every bound ChannelAdapter". */
export const CHANNEL_ADAPTERS = Symbol('CHANNEL_ADAPTERS');

@Injectable()
export class ChannelRegistry {
  private readonly adapters: ReadonlyMap<ChannelKind, ChannelAdapter>;

  constructor(@Inject(CHANNEL_ADAPTERS) adapters: readonly ChannelAdapter[]) {
    const byChannel = new Map<ChannelKind, ChannelAdapter>();
    for (const adapter of adapters) {
      if (byChannel.has(adapter.channel)) {
        // Two bindings for one channel means one of them silently never
        // runs — a wiring bug that would show up as "some replies just
        // don't send", which is the hardest possible thing to diagnose in
        // production. Fail at boot instead.
        throw new Error(
          `Two ChannelAdapters are bound to channel "${adapter.channel}".`,
        );
      }
      byChannel.set(adapter.channel, adapter);
    }
    this.adapters = byChannel;
  }

  /** @throws UnsupportedChannelError when nothing is bound for this channel. */
  for(channel: ChannelKind): ChannelAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new UnsupportedChannelError(channel);
    return adapter;
  }

  /** Which channels actually have a binding — used by the webhook controller to reject a payload for a channel we do not serve. */
  channels(): ChannelKind[] {
    return [...this.adapters.keys()];
  }
}
