// Channel (MetaChannelModule, Feature 16): the TENANT-facing view of
// connected Meta channels — what the console lists and disconnects.
// Connecting is MetaConnectService (Gulf T4), which never takes a token from
// the client.
//
// The mirror of `WhatsappNumberDirectory`, and it inherits that class's most
// important property: `social_channels` carries no row-level security (it is
// read during webhook routing, before a tenant is known), so every read and
// write here filters by `tenant_id` explicitly. That filter IS the isolation
// boundary, not decoration. Credentials are never selected.
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  socialChannels,
  type SocialChannelConnectionState,
} from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import type { ChannelKind } from '../channel/ports/channel-kind';

export interface ConnectedSocialChannel {
  id: string;
  channel: ChannelKind;
  channelAccountId: string;
  pageId: string;
  displayName: string | null;
  connectionState: SocialChannelConnectionState;
  connectionError: string | null;
  tokenExpiresAt: Date | null;
}

@Injectable()
export class SocialChannelDirectory {
  constructor(private readonly persistence: PersistenceService) {}

  async listForTenant(tenantId: string): Promise<ConnectedSocialChannel[]> {
    return this.persistence.runAdminQuery((db) =>
      db
        .select({
          id: socialChannels.id,
          channel: socialChannels.channel,
          channelAccountId: socialChannels.channelAccountId,
          pageId: socialChannels.pageId,
          displayName: socialChannels.displayName,
          connectionState: socialChannels.connectionState,
          connectionError: socialChannels.connectionError,
          tokenExpiresAt: socialChannels.tokenExpiresAt,
        })
        .from(socialChannels)
        .where(eq(socialChannels.tenantId, tenantId)),
    );
  }

  /**
   * Disconnect. Scoped by BOTH id and tenant so a guessed/leaked channel id
   * from another workspace deletes nothing — the tenant predicate is the
   * check, since this table has no RLS to fall back on.
   *
   * @returns false when nothing matched (unknown id, or another tenant's).
   */
  async disconnect(tenantId: string, id: string): Promise<boolean> {
    const deleted = await this.persistence.runAdminQuery((db) =>
      db
        .delete(socialChannels)
        .where(
          and(eq(socialChannels.id, id), eq(socialChannels.tenantId, tenantId)),
        )
        .returning({ id: socialChannels.id }),
    );
    return deleted.length > 0;
  }
}
