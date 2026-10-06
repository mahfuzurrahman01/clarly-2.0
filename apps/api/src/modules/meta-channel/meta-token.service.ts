// Channel (MetaChannelModule, Feature 16): the token lifecycle — the piece
// the 2026-09-06 eng review made mandatory, and the difference between a
// Meta integration that works in a demo and one that survives 60 days.
//
// The problem it solves: Meta's long-lived page/IG access tokens expire.
// When one does, every send for that tenant's channel starts failing with an
// OAuthException. Without explicit handling that shows up as "our Instagram
// stopped working and nobody told us" — messages ingested, replies silently
// never delivered.
//
// Three behaviours, in the order they matter:
//
//   1. PRE-EMPTIVE. `ensureFreshToken()` refreshes a token that is inside
//      META_TOKEN_REFRESH_WINDOW_MS of expiring, BEFORE it is used. Called on
//      the send path, so a channel that only gets traffic keeps itself alive
//      with no scheduler involved at all.
//   2. SWEPT. `refreshExpiringChannels()` does the same for quiet channels,
//      on a repeatable BullMQ job. A channel with no traffic in the last week
//      of its token's life would otherwise expire un-noticed and greet its
//      next customer with a failure.
//   3. DEGRADED, NEVER SILENT. A refresh Meta refuses (`isTokenInvalid`)
//      moves that ONE channel to `reconnect_required` and raises a
//      notification. Its inbound messages keep being ingested and keep
//      reaching a human; only automated sending stops. A refresh that fails
//      for a NETWORK reason does NOT degrade anything — a Graph blip must
//      not cost a tenant their connection.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import {
  MetaGraphClient,
  MetaGraphError,
  type GraphTokenExchangeResult,
} from '../meta-graph/meta-graph.module';
import {
  SocialChannelCredentialsService,
  type MetaChannelCredentials,
  type SocialChannelState,
} from './social-channel-credentials.service';
import {
  MetaTokenRefreshError,
  SocialChannelReconnectRequiredError,
} from './social-channel.errors';

/**
 * How close to expiry a token gets refreshed. Seven days, because Meta's
 * long-lived tokens run ~60 days and the sweep runs daily: a full week of
 * daily attempts before anything breaks means a transient Graph outage costs
 * a retry, not a tenant's channel.
 */
export const TOKEN_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Cap per sweep, so one pass cannot spend an unbounded amount of time (or Graph quota) on a large tenant base. */
export const TOKEN_REFRESH_SWEEP_BATCH = 100;

export interface TokenRefreshOutcome {
  channelAccountId: string;
  status: 'fresh' | 'refreshed' | 'reconnect_required' | 'deferred';
  detail?: string;
}

@Injectable()
export class MetaTokenService {
  constructor(
    private readonly graph: MetaGraphClient,
    private readonly credentials: SocialChannelCredentialsService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Returns a page access token that is safe to send with, refreshing first
   * if it is close to expiry.
   *
   * @throws SocialChannelReconnectRequiredError when the channel is already
   *   degraded, or becomes degraded during this call. The send path turns
   *   that into an escalation ticket — a human answers the customer — and
   *   never into a dropped message.
   */
  async ensureFreshToken(channelAccountId: string): Promise<string> {
    const state = await this.credentials.getState(channelAccountId);

    if (state.connectionState === 'reconnect_required') {
      // Not retried here on purpose. The tenant has to re-consent in the
      // console; hammering Graph on every inbound message would just burn
      // quota to reproduce the same refusal.
      throw new SocialChannelReconnectRequiredError(
        channelAccountId,
        state.connectionError,
      );
    }

    const credentials = await this.credentials.getCredentials(channelAccountId);
    if (!this.needsRefresh(state, new Date())) {
      return credentials.pageAccessToken;
    }

    const outcome = await this.refresh(state, credentials);
    if (outcome.status === 'reconnect_required') {
      throw new SocialChannelReconnectRequiredError(
        channelAccountId,
        outcome.detail ?? null,
      );
    }
    if (outcome.status === 'refreshed') {
      return (await this.credentials.getCredentials(channelAccountId))
        .pageAccessToken;
    }
    // 'deferred' — the refresh failed for a transient reason and the CURRENT
    // token has not expired yet. Using it is strictly better than failing:
    // the sweep will try again, and meanwhile the customer gets an answer.
    return credentials.pageAccessToken;
  }

  /** The sweep (behaviour 2). Never throws — one bad channel must not abort the pass for every other tenant. */
  async refreshExpiringChannels(now: Date): Promise<TokenRefreshOutcome[]> {
    const cutoff = new Date(now.getTime() + TOKEN_REFRESH_WINDOW_MS);
    const due = await this.credentials.listExpiringBefore(
      cutoff,
      TOKEN_REFRESH_SWEEP_BATCH,
    );

    const outcomes: TokenRefreshOutcome[] = [];
    for (const state of due) {
      if (state.connectionState === 'reconnect_required') {
        // Already degraded and already reported. Re-attempting every sweep
        // would be a permanent, pointless load against Graph.
        outcomes.push({
          channelAccountId: state.channelAccountId,
          status: 'reconnect_required',
          detail: state.connectionError ?? undefined,
        });
        continue;
      }

      try {
        const credentials = await this.credentials.getCredentials(
          state.channelAccountId,
        );
        outcomes.push(await this.refresh(state, credentials));
      } catch (error) {
        outcomes.push({
          channelAccountId: state.channelAccountId,
          status: 'deferred',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return outcomes;
  }

  /** True when the token is inside the refresh window. A null expiry is NOT due: Meta never gave us one (system-user tokens), so there is nothing to pre-empt. */
  needsRefresh(state: SocialChannelState, now: Date): boolean {
    if (!state.tokenExpiresAt) return false;
    return (
      state.tokenExpiresAt.getTime() - now.getTime() <= TOKEN_REFRESH_WINDOW_MS
    );
  }

  /**
   * One refresh attempt.
   *
   * Two Graph calls, in this order and not the other: extend the long-lived
   * USER token, then re-read the PAGE token with it. Page tokens have no
   * refresh grant of their own — the user token is the root of trust, and
   * doing it the other way round would refresh nothing.
   */
  private async refresh(
    state: SocialChannelState,
    credentials: MetaChannelCredentials,
  ): Promise<TokenRefreshOutcome> {
    const { channelAccountId } = state;

    if (!credentials.userAccessToken) {
      // Nothing to refresh FROM. Only two ways to get here: a system-user
      // token (which does not expire, so `needsRefresh` never fires) or a
      // connection stored without its user token. If we are here with an
      // expiry in sight, it is the latter and only re-consent fixes it.
      return this.degrade(
        channelAccountId,
        'This channel was connected without a re-usable Facebook Login token, so its page token cannot be renewed automatically. Reconnect the channel to continue replying.',
      );
    }

    let exchanged: GraphTokenExchangeResult;
    let pageAccessToken: string;
    try {
      exchanged = await this.graph.exchangeLongLivedUserToken({
        userAccessToken: credentials.userAccessToken,
      });
      pageAccessToken = await this.graph.fetchPageAccessToken({
        userAccessToken: exchanged.accessToken,
        pageId: state.pageId,
      });
    } catch (error) {
      if (error instanceof MetaGraphError && error.isTokenInvalid) {
        return this.degrade(
          channelAccountId,
          `Meta rejected the stored credentials (${error.message}). Reconnect the channel to continue replying.`,
        );
      }
      // Transient — a 500, a timeout, a rate limit. Deliberately NOT a
      // degrade: a Graph blip must not cost a tenant their channel.
      const detail = new MetaTokenRefreshError(
        channelAccountId,
        error instanceof Error ? error.message : String(error),
      ).message;
      this.logger.warn(detail, MetaTokenService.name);
      return { channelAccountId, status: 'deferred', detail };
    }

    await this.credentials.recordRefreshedToken(
      channelAccountId,
      {
        pageAccessToken,
        userAccessToken: exchanged.accessToken,
      },
      exchanged.expiresInSeconds === null
        ? null
        : new Date(Date.now() + exchanged.expiresInSeconds * 1000),
    );

    this.logger.log(
      `refreshed the Meta access token for channel ${channelAccountId}`,
      MetaTokenService.name,
    );
    return { channelAccountId, status: 'refreshed' };
  }

  private async degrade(
    channelAccountId: string,
    reason: string,
  ): Promise<TokenRefreshOutcome> {
    await this.credentials.markReconnectRequired(channelAccountId, reason);
    // error, not warn: a tenant is now partially offline, and this is the
    // line an on-call person greps for. The tenant-facing half of this is the
    // `reconnect_required` state their console reads, plus the escalation
    // ticket any attempted send now produces.
    this.logger.error(
      `Meta channel ${channelAccountId} degraded to reconnect_required: ${reason}`,
      undefined,
      MetaTokenService.name,
    );
    return { channelAccountId, status: 'reconnect_required', detail: reason };
  }
}
