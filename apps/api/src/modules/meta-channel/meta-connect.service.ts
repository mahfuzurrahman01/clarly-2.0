// Channel (MetaChannelModule, Gulf T4 / D4): the server-side Messenger and
// Instagram connect handshake.
//
// Before T4, `POST /channels/meta` accepted a page id and a page token from
// the browser and stored them. Nothing tied the token to the page id, so any
// tenant admin could claim any page id they typed (the "page squat"). The
// fix is to never accept a page token from a client:
//
//   Step A  startHandshake(): the browser sends only its short-lived
//           Facebook Login token. We exchange it for a long-lived one, read
//           `/me` and `/me/accounts`, keep Meta's answer server-side
//           (MetaConnectHandshakeStore), and return the page list with no
//           tokens in it.
//   Step B  connect(): the browser names a page from that list. The page
//           token comes from Meta's own `/me/accounts` answer. A page that is
//           not in it is refused: the user has no role on it.
//
// Then, in this order: cross-tenant ownership check (409, before any call
// to Meta), `POST /{page-id}/subscribed_apps` (nothing is stored if Meta
// refuses), then the encrypted upsert with the long-lived user token (so
// MetaTokenService can re-mint the page token later) and the `/me` id (so
// T7's deauthorize and data-deletion callbacks can find the row).
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import type { ChannelKind } from '../channel/ports/channel-kind';
import {
  MetaGraphClient,
  MetaGraphError,
  type GraphLinkedInstagramAccount,
  type GraphManagedPage,
} from '../meta-graph/meta-graph.module';
import {
  MetaConnectHandshakeStore,
  type HandshakeOwner,
} from './meta-connect-handshake.store';
import { SocialChannelCredentialsService } from './social-channel-credentials.service';
import {
  MetaConnectHandshakeExpiredError,
  MetaInstagramNotLinkedError,
  MetaLoginTokenRejectedError,
  MetaPageNotManagedError,
  SocialChannelOwnedByAnotherTenantError,
} from './social-channel.errors';

/**
 * Page webhook fields we subscribe. `messages` carries Messenger and
 * Instagram DMs (and echoes, which the parser skips); `messaging_postbacks`
 * carries button taps; `message_deliveries` feeds the `delivered` status.
 * `message_reads` is left out on purpose: the parser ignores reads (Meta
 * sends a watermark, not message ids).
 *
 * Gulf T8 (F23): `feed` carries comments on the page's posts (comment
 * automation). Instagram `comments` is an app-level field and needs no
 * page subscription beyond this call.
 */
export const META_PAGE_SUBSCRIBED_FIELDS: readonly string[] = [
  'messages',
  'messaging_postbacks',
  'message_deliveries',
  'feed',
];

export type SocialChannelKind = Extract<ChannelKind, 'messenger' | 'instagram'>;

/** A page as the console's picker sees it. No token, ever. */
export interface ConnectablePage {
  id: string;
  name: string | null;
  instagram: GraphLinkedInstagramAccount | null;
}

export interface StartHandshakeResult {
  handshakeId: string;
  expiresAt: Date;
  pages: ConnectablePage[];
}

export interface StartHandshakeInput extends HandshakeOwner {
  /** The SHORT-lived user token from Facebook Login for Business. */
  userAccessToken: string;
}

export interface ConnectPageInput extends HandshakeOwner {
  handshakeId: string;
  pageId: string;
  channels: readonly SocialChannelKind[];
}

interface ConnectTarget {
  channel: SocialChannelKind;
  channelAccountId: string;
  displayName: string | null;
}

@Injectable()
export class MetaConnectService {
  constructor(
    private readonly graph: MetaGraphClient,
    private readonly handshakes: MetaConnectHandshakeStore,
    private readonly credentials: SocialChannelCredentialsService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Step A.
   *
   * @throws MetaLoginTokenRejectedError when Meta refuses the login token.
   * @throws MetaGraphError for any other Graph failure (transient).
   */
  async startHandshake(
    input: StartHandshakeInput,
  ): Promise<StartHandshakeResult> {
    let userAccessToken: string;
    let metaUserId: string;
    let pages: GraphManagedPage[];
    try {
      userAccessToken = (
        await this.graph.exchangeLongLivedUserToken({
          userAccessToken: input.userAccessToken,
        })
      ).accessToken;
      metaUserId = (await this.graph.getMe(userAccessToken)).id;
      pages = await this.graph.listPages(userAccessToken);
    } catch (error) {
      if (error instanceof MetaGraphError && error.isTokenInvalid) {
        throw new MetaLoginTokenRejectedError(error.message);
      }
      throw error;
    }

    const { handshakeId, expiresAt } = await this.handshakes.save({
      tenantId: input.tenantId,
      userId: input.userId,
      metaUserId,
      userAccessToken,
      pages,
    });

    this.logger.log(
      `Meta connect handshake started for tenant ${input.tenantId}: ${pages.length} page(s) available`,
      MetaConnectService.name,
    );

    return {
      handshakeId,
      expiresAt,
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        instagram: page.instagram,
      })),
    };
  }

  /**
   * Step B.
   *
   * @throws MetaConnectHandshakeExpiredError unknown/expired/not-yours handshake.
   * @throws MetaPageNotManagedError the page is not in Meta's list for this user (403).
   * @throws MetaInstagramNotLinkedError Instagram requested, no linked IG account.
   * @throws SocialChannelOwnedByAnotherTenantError page or IG account belongs to another tenant (409).
   * @throws MetaGraphError Meta refused the webhook subscription; nothing stored.
   */
  async connect(input: ConnectPageInput): Promise<void> {
    const handshake = await this.handshakes.load(input.handshakeId, input);
    if (!handshake) throw new MetaConnectHandshakeExpiredError();

    const page = handshake.pages.find(
      (candidate) => candidate.id === input.pageId,
    );
    if (!page) throw new MetaPageNotManagedError(input.pageId);

    const targets = this.targetsFor(page, input.channels);
    await this.assertNotOwnedElsewhere(input.tenantId, targets);

    await this.graph.subscribeApp({
      pageId: page.id,
      pageAccessToken: page.accessToken,
      subscribedFields: META_PAGE_SUBSCRIBED_FIELDS,
    });

    const tokenExpiresAt = await this.pageTokenExpiry(page.accessToken);

    for (const target of targets) {
      await this.credentials.upsert({
        tenantId: input.tenantId,
        channel: target.channel,
        channelAccountId: target.channelAccountId,
        pageId: page.id,
        displayName: target.displayName,
        credentials: {
          pageAccessToken: page.accessToken,
          userAccessToken: handshake.userAccessToken,
        },
        tokenExpiresAt,
        connectedByMetaUserId: handshake.metaUserId,
      });
      this.logger.log(
        `connected ${target.channel} account ${target.channelAccountId} (page ${page.id}) for tenant ${input.tenantId}`,
        MetaConnectService.name,
      );
    }
  }

  private targetsFor(
    page: GraphManagedPage,
    channels: readonly SocialChannelKind[],
  ): ConnectTarget[] {
    return [...new Set(channels)].map((channel) => {
      if (channel === 'messenger') {
        return { channel, channelAccountId: page.id, displayName: page.name };
      }
      if (!page.instagram) throw new MetaInstagramNotLinkedError(page.id);
      return {
        channel,
        channelAccountId: page.instagram.id,
        displayName: page.instagram.username ?? page.name,
      };
    });
  }

  /**
   * Fails fast, before we subscribe anything at Meta, when any requested
   * account belongs to another tenant. `upsert()` repeats the check (and the
   * unique constraint backs it) for the race this read cannot close.
   */
  private async assertNotOwnedElsewhere(
    tenantId: string,
    targets: readonly ConnectTarget[],
  ): Promise<void> {
    for (const target of targets) {
      const owner = await this.credentials.findOwnerTenantId(
        target.channelAccountId,
      );
      if (owner !== null && owner !== tenantId) {
        throw new SocialChannelOwnedByAnotherTenantError(
          target.channelAccountId,
        );
      }
    }
  }

  /**
   * Meta's own expiry for the page token via `/debug_token`. A page token
   * minted from a long-lived user token normally has none (expires_at 0,
   * read as null). A failed lookup is not fatal: null means "cannot be
   * pre-empted", not "expired".
   */
  private async pageTokenExpiry(pageAccessToken: string): Promise<Date | null> {
    try {
      return (await this.graph.inspectToken(pageAccessToken)).expiresAt;
    } catch {
      return null;
    }
  }
}
