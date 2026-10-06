// Channel (MetaChannelModule, Feature 16 / T6): resolves an inbound Meta
// webhook's `entry[].id` (a Facebook page id or an Instagram account id) to
// a `tenant_id` — the FIRST thing that happens to any inbound Meta webhook,
// before dedup, before rate limiting, before anything tenant-scoped.
//
// Deliberately the exact shape of `WhatsappNumberResolutionService`,
// including its constraint: `runAdminQuery()` (there is no tenant context
// yet — establishing one IS the point), and it selects only routing/state
// columns, NEVER `credentialsEncrypted`. Credentials are the outbound
// path's business and reached through SocialChannelCredentialsService,
// which runs after auth and after a tenant is known — the same
// two-services-two-trust-levels split T6 already made for WhatsApp.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  socialChannels,
  type SocialChannelConnectionState,
} from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import type { ChannelKind } from '../channel/ports/channel-kind';
import { UnknownSocialChannelError } from './social-channel.errors';

export interface ResolvedSocialChannel {
  tenantId: string;
  channel: ChannelKind;
  channelAccountId: string;
  /** The page whose token authorizes sends — differs from channelAccountId on Instagram. */
  pageId: string;
  connectionState: SocialChannelConnectionState;
}

@Injectable()
export class SocialChannelResolutionService {
  constructor(private readonly persistence: PersistenceService) {}

  /** @throws UnknownSocialChannelError when no tenant has connected this account. */
  async resolve(channelAccountId: string): Promise<ResolvedSocialChannel> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({
          tenantId: socialChannels.tenantId,
          channel: socialChannels.channel,
          channelAccountId: socialChannels.channelAccountId,
          pageId: socialChannels.pageId,
          connectionState: socialChannels.connectionState,
        })
        .from(socialChannels)
        .where(eq(socialChannels.channelAccountId, channelAccountId))
        .limit(1),
    );

    if (rows.length === 0) {
      throw new UnknownSocialChannelError(channelAccountId);
    }

    return rows[0];
  }

  /** Convenience for the ingest path, which only needs the tenant. */
  async resolveTenantId(channelAccountId: string): Promise<string> {
    return (await this.resolve(channelAccountId)).tenantId;
  }
}
