// Channel (MetaChannelModule, Feature 16 / T6): the encrypted-credential
// store for Meta social channels, plus the token lifecycle state that sits
// next to it.
//
// Reuses `BspCredentialsEncryptionService` rather than standing up a second
// AES-GCM implementation (DRY, and more importantly: one crypto
// implementation to audit, one key to rotate). That service's name says
// "BSP" because it predates this feature; what it actually is, is the
// platform's per-tenant channel-credential cipher.
//
// `runAdminQuery()` for the same reason `BspCredentialsService` uses it:
// `social_channels` carries no RLS policy (it is read before tenant context
// exists — see social-channels.table.ts), so a withTenantTx() read would
// enforce nothing extra, and the lookup key is unique platform-wide. Every
// TENANT-facing read goes through SocialChannelDirectory, which filters by
// tenant explicitly.
import { Injectable } from '@nestjs/common';
import { eq, lte } from 'drizzle-orm';
import { hashMetaUserId } from '../meta-graph/meta-user-id-hash';
import {
  socialChannels,
  type SocialChannelConnectionState,
} from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { isUniqueViolation } from '../persistence/postgres-error';
import { BspCredentialsEncryptionService } from '../whatsapp/bsp-credentials-encryption.service';
import type { ChannelKind } from '../channel/ports/channel-kind';
import {
  SocialChannelOwnedByAnotherTenantError,
  UnknownSocialChannelError,
} from './social-channel.errors';

/** What we store, encrypted, per connected Meta channel. */
export interface MetaChannelCredentials {
  /** The long-lived PAGE access token. What actually authorizes a send. */
  pageAccessToken: string;
  /**
   * The long-lived USER access token the page token was derived from, when
   * the tenant connected via Facebook Login.
   *
   * Kept because it is the ONLY way to mint a fresh page token without
   * dragging the tenant back through the OAuth consent screen: Meta's page
   * tokens are re-read from `/me/accounts` using the user token, they are
   * not independently refreshable. Optional — a channel connected with a
   * system-user token has no user token behind it (and needs none, those do
   * not expire).
   */
  userAccessToken?: string;
}

/** A channel a privacy callback acted on — enough to log and notify, never the credentials. */
export interface AffectedSocialChannel {
  tenantId: string;
  channelAccountId: string;
}

export interface SocialChannelState {
  id: string;
  tenantId: string;
  channel: ChannelKind;
  channelAccountId: string;
  pageId: string;
  tokenExpiresAt: Date | null;
  connectionState: SocialChannelConnectionState;
  connectionError: string | null;
}

@Injectable()
export class SocialChannelCredentialsService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly encryption: BspCredentialsEncryptionService,
  ) {}

  /** @throws UnknownSocialChannelError when nothing is connected under this id. */
  async getCredentials(
    channelAccountId: string,
  ): Promise<MetaChannelCredentials> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({ encrypted: socialChannels.credentialsEncrypted })
        .from(socialChannels)
        .where(eq(socialChannels.channelAccountId, channelAccountId))
        .limit(1),
    );

    if (rows.length === 0)
      throw new UnknownSocialChannelError(channelAccountId);

    // decrypt() throws CredentialsDecryptionError on tamper/key mismatch —
    // deliberately allowed to propagate rather than being remapped into a
    // "needs reconnecting", which would tell a tenant to redo their OAuth
    // over what is actually our key-management problem.
    const decrypted = this.encryption.decrypt(rows[0].encrypted);
    const pageAccessToken = decrypted.pageAccessToken;
    if (typeof pageAccessToken !== 'string' || pageAccessToken.length === 0) {
      throw new Error(
        `Stored Meta credentials for "${channelAccountId}" have no usable pageAccessToken.`,
      );
    }
    const userAccessToken = decrypted.userAccessToken;

    return {
      pageAccessToken,
      ...(typeof userAccessToken === 'string' && userAccessToken.length > 0
        ? { userAccessToken }
        : {}),
    };
  }

  /** The tenant that has this account connected, or null when none does. Never reads credentials. */
  async findOwnerTenantId(channelAccountId: string): Promise<string | null> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({ tenantId: socialChannels.tenantId })
        .from(socialChannels)
        .where(eq(socialChannels.channelAccountId, channelAccountId))
        .limit(1),
    );
    return rows[0]?.tenantId ?? null;
  }

  async getState(channelAccountId: string): Promise<SocialChannelState> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({
          id: socialChannels.id,
          tenantId: socialChannels.tenantId,
          channel: socialChannels.channel,
          channelAccountId: socialChannels.channelAccountId,
          pageId: socialChannels.pageId,
          tokenExpiresAt: socialChannels.tokenExpiresAt,
          connectionState: socialChannels.connectionState,
          connectionError: socialChannels.connectionError,
        })
        .from(socialChannels)
        .where(eq(socialChannels.channelAccountId, channelAccountId))
        .limit(1),
    );

    if (rows.length === 0)
      throw new UnknownSocialChannelError(channelAccountId);
    return rows[0];
  }

  /**
   * Connect or re-connect. Idempotent on `channelAccountId` so re-running an
   * OAuth callback swaps the token instead of failing on the unique
   * constraint — and clears any prior `reconnect_required`, because a fresh
   * consent is exactly the fix that state asks for.
   *
   * Ownership is checked FIRST and never transferred. Without that check,
   * "connect this page" would be a cross-tenant takeover primitive: tenant B
   * completing Meta's OAuth for a page tenant A already connected would
   * silently repoint A's inbound webhooks — and A's customers' messages — at
   * B. Moving an account between tenants is an explicit
   * disconnect-then-connect, never a side effect of a re-connect.
   *
   * @throws SocialChannelOwnedByAnotherTenantError
   */
  async upsert(input: {
    tenantId: string;
    channel: ChannelKind;
    channelAccountId: string;
    pageId: string;
    displayName: string | null;
    credentials: MetaChannelCredentials;
    tokenExpiresAt: Date | null;
    /**
     * Gulf T7: the app-scoped id of the Facebook user whose login granted
     * these tokens, when the caller knows it (T4's handshake reads it from
     * `/me`). Stored hashed; it is what lets Meta's deauthorize and
     * data-deletion callbacks find this row. Omitted = leave any previously
     * recorded user in place.
     */
    connectedByMetaUserId?: string;
  }): Promise<void> {
    const credentialsEncrypted = this.encryption.encrypt({
      ...input.credentials,
    });

    const owner = await this.persistence.runAdminQuery((db) =>
      db
        .select({ tenantId: socialChannels.tenantId })
        .from(socialChannels)
        .where(eq(socialChannels.channelAccountId, input.channelAccountId))
        .limit(1),
    );

    if (owner.length > 0 && owner[0].tenantId !== input.tenantId) {
      throw new SocialChannelOwnedByAnotherTenantError(input.channelAccountId);
    }

    const values = {
      tenantId: input.tenantId,
      channel: input.channel,
      channelAccountId: input.channelAccountId,
      pageId: input.pageId,
      displayName: input.displayName,
      credentialsEncrypted,
      tokenExpiresAt: input.tokenExpiresAt,
      connectionState: 'connected' as const,
      connectionError: null,
      ...(input.connectedByMetaUserId
        ? {
            connectedByMetaUserHash: hashMetaUserId(
              input.connectedByMetaUserId,
            ),
          }
        : {}),
    };

    if (owner.length > 0) {
      await this.persistence.runAdminQuery((db) =>
        db
          .update(socialChannels)
          .set({
            ...values,
            tokenRefreshedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(socialChannels.channelAccountId, input.channelAccountId)),
      );
      return;
    }

    try {
      await this.persistence.runAdminQuery((db) =>
        db.insert(socialChannels).values(values),
      );
    } catch (error) {
      // Lost the race against another tenant connecting the same account in
      // the same instant. The unique constraint — not the read above — is
      // what actually makes ownership exclusive; this branch just reports it
      // as the same refusal rather than a 500.
      if (isUniqueViolation(error)) {
        throw new SocialChannelOwnedByAnotherTenantError(
          input.channelAccountId,
        );
      }
      throw error;
    }
  }

  /** Records a successful refresh: new token, new expiry, back to 'connected'. */
  async recordRefreshedToken(
    channelAccountId: string,
    credentials: MetaChannelCredentials,
    tokenExpiresAt: Date | null,
  ): Promise<void> {
    await this.persistence.runAdminQuery((db) =>
      db
        .update(socialChannels)
        .set({
          credentialsEncrypted: this.encryption.encrypt({ ...credentials }),
          tokenExpiresAt,
          tokenRefreshedAt: new Date(),
          connectionState: 'connected',
          connectionError: null,
          updatedAt: new Date(),
        })
        .where(eq(socialChannels.channelAccountId, channelAccountId)),
    );
  }

  /**
   * Degrades ONE channel to "reconnect needed".
   *
   * The credentials are left in place on purpose. They are already useless
   * for sending, and wiping them would destroy the only diagnostic evidence
   * of what was connected — while making the failure look, to anyone
   * reading the row later, like the tenant never connected at all.
   */
  async markReconnectRequired(
    channelAccountId: string,
    reason: string,
  ): Promise<void> {
    await this.persistence.runAdminQuery((db) =>
      db
        .update(socialChannels)
        .set({
          connectionState: 'reconnect_required',
          connectionError: reason.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(socialChannels.channelAccountId, channelAccountId)),
    );
  }

  /**
   * Gulf T7 (D7), Deauthorize callback: the Meta user removed our app, so
   * every token their login granted is now dead. Degrades EVERY channel that
   * user connected — across tenants, because one Facebook user can admin
   * pages for several workspaces — and nothing else. The match is on the
   * user hash alone; there is no tenant scope to add, and none is needed:
   * the signed_request already proved Meta is talking about this user.
   *
   * Credentials stay in place, same reasoning as markReconnectRequired().
   * The user hash stays too, so a later data-deletion request for the same
   * user still finds these rows.
   */
  async markReconnectRequiredForMetaUser(
    metaUserId: string,
    reason: string,
  ): Promise<AffectedSocialChannel[]> {
    return this.persistence.runAdminQuery((db) =>
      db
        .update(socialChannels)
        .set({
          connectionState: 'reconnect_required',
          connectionError: reason.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(
          eq(
            socialChannels.connectedByMetaUserHash,
            hashMetaUserId(metaUserId),
          ),
        )
        .returning({
          tenantId: socialChannels.tenantId,
          channelAccountId: socialChannels.channelAccountId,
        }),
    );
  }

  /**
   * Gulf T7 (D7), Data Deletion Request callback: erase what we hold that
   * came from this Meta user — the user access token and the page tokens
   * derived from it — and the link to the user itself.
   *
   * The channel ROW is kept, degraded to `reconnect_required`, rather than
   * deleted: the page belongs to the tenant's business, not to the person
   * who clicked "connect", and deleting the row would silently stop routing
   * that business's inbound customer messages. A re-connect by any admin
   * restores it. `credentials_encrypted` is NOT NULL, so it becomes the
   * ciphertext of an empty object — no token survives.
   *
   * Idempotent: the user hash is cleared, so a repeat finds nothing.
   */
  async scrubCredentialsForMetaUser(
    metaUserId: string,
    reason: string,
  ): Promise<AffectedSocialChannel[]> {
    const emptyCredentials = this.encryption.encrypt({});
    return this.persistence.runAdminQuery((db) =>
      db
        .update(socialChannels)
        .set({
          credentialsEncrypted: emptyCredentials,
          tokenExpiresAt: null,
          tokenRefreshedAt: null,
          connectionState: 'reconnect_required',
          connectionError: reason.slice(0, 500),
          connectedByMetaUserHash: null,
          updatedAt: new Date(),
        })
        .where(
          eq(
            socialChannels.connectedByMetaUserHash,
            hashMetaUserId(metaUserId),
          ),
        )
        .returning({
          tenantId: socialChannels.tenantId,
          channelAccountId: socialChannels.channelAccountId,
        }),
    );
  }

  /**
   * Channels whose token expires at or before `before`, oldest expiry first.
   * The token-refresh sweep's only query.
   *
   * Rows with a NULL `tokenExpiresAt` are excluded, and that is the correct
   * reading of null here: it means Meta never gave us an expiry (system-user
   * tokens), so there is nothing to pre-empt. A null does not mean "expired".
   */
  async listExpiringBefore(
    before: Date,
    limit: number,
  ): Promise<SocialChannelState[]> {
    return this.persistence.runAdminQuery((db) =>
      db
        .select({
          id: socialChannels.id,
          tenantId: socialChannels.tenantId,
          channel: socialChannels.channel,
          channelAccountId: socialChannels.channelAccountId,
          pageId: socialChannels.pageId,
          tokenExpiresAt: socialChannels.tokenExpiresAt,
          connectionState: socialChannels.connectionState,
          connectionError: socialChannels.connectionError,
        })
        .from(socialChannels)
        .where(lte(socialChannels.tokenExpiresAt, before))
        .orderBy(socialChannels.tokenExpiresAt)
        .limit(limit),
    );
  }
}
