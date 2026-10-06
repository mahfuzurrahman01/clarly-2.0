// Gulf T8 (D6, D11): performs one comment action on Meta — at most once.
//
//   claim (comment_id, action)  ──►  Graph call  ──►  succeeded | failed | released
//
// The claim is taken BEFORE the Graph call (D6). A replay, a retry or a second
// worker that reaches the same action finds the row and never calls Meta again.
// A claim is handed back (`released`) only when we know Meta did not perform
// the call: our own limiter refused first, or Meta answered with a throttling
// error. Those two cases defer the job (delayed, never dropped, D11). Anything
// else that goes wrong after the claim — a timeout, a 5xx, a refusal — leaves
// the row `failed` and is never retried: for a private reply a duplicate is
// worse than a miss, and Meta allows only one per comment anyway.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import {
  MetaGraphClient,
  MetaGraphError,
  type GraphCommentSurface,
} from '../meta-graph/meta-graph.module';
import { MetaTokenService } from '../meta-channel/meta-token.service';
import { SocialChannelResolutionService } from '../meta-channel/social-channel-resolution.service';
import type { CommentAction } from '../persistence/drizzle/schema';
import type { ChannelKind } from '../channel/ports/channel-kind';
import {
  CommentLedgerService,
  type CommentEventRecord,
} from './comment-ledger.service';
import { CommentRateLimiter } from './comment-rate-limiter.service';
import { CommentDeferredError } from './comment.errors';

/** How long to wait after Meta itself throttles us. Meta does not say; its limits are hourly windows. */
export const META_THROTTLE_BACKOFF_MS = 15 * 60 * 1000;

export type ActionOutcome =
  /** Meta confirmed it, just now. */
  | 'succeeded'
  /** A previous attempt already succeeded (replay / retry). */
  | 'already_done'
  /** Refused, or outcome unknown. Will not be attempted again. */
  | 'failed';

type ActionEvent = Pick<
  CommentEventRecord,
  'id' | 'tenantId' | 'channel' | 'channelAccountId' | 'commentId'
>;

interface GraphContext {
  pageId: string;
  pageAccessToken: string;
  surface: GraphCommentSurface;
}

@Injectable()
export class CommentActionExecutor {
  constructor(
    private readonly ledger: CommentLedgerService,
    private readonly graph: MetaGraphClient,
    private readonly tokens: MetaTokenService,
    private readonly channels: SocialChannelResolutionService,
    private readonly limiter: CommentRateLimiter,
    private readonly logger: AppLoggerService,
  ) {}

  hide(event: ActionEvent): Promise<ActionOutcome> {
    return this.run(event, 'hide', async (ctx) => {
      await this.graph.hideComment({
        surface: ctx.surface,
        commentId: event.commentId,
        pageAccessToken: ctx.pageAccessToken,
      });
      return null;
    });
  }

  publicReply(event: ActionEvent, message: string): Promise<ActionOutcome> {
    return this.run(event, 'public_reply', async (ctx) => {
      const { id } = await this.graph.replyToComment({
        surface: ctx.surface,
        commentId: event.commentId,
        message,
        pageAccessToken: ctx.pageAccessToken,
      });
      return id;
    });
  }

  /**
   * @throws CommentDeferredError when the private-reply limiter (ours or
   *   Meta's) says not now. The claim is released first, so the deferred job
   *   can take it again.
   */
  privateReply(
    event: ActionEvent,
    text: string,
    now: Date,
  ): Promise<ActionOutcome> {
    return this.run(event, 'private_reply', async (ctx) => {
      const window = await this.limiter.privateReply(
        event.channel,
        event.channelAccountId,
        now,
      );
      if (!window.allowed) {
        throw new CommentDeferredError(
          window.retryAfterMs,
          `${event.channel} private-reply limit reached for ${event.channelAccountId}`,
        );
      }
      const sent = await this.graph.sendPrivateReply({
        pageId: ctx.pageId,
        commentId: event.commentId,
        text,
        pageAccessToken: ctx.pageAccessToken,
      });
      await this.ledger.recordPrivateReplySent(event.tenantId, event.id, {
        recipientId: sent.recipientId,
        messageId: sent.messageId,
        sentAt: now,
      });
      return sent.messageId;
    });
  }

  private async run(
    event: ActionEvent,
    action: CommentAction,
    call: (ctx: GraphContext) => Promise<string | null>,
  ): Promise<ActionOutcome> {
    const claim = await this.ledger.claimAction(
      event.tenantId,
      event.id,
      event.commentId,
      action,
    );
    if (claim === 'succeeded') return 'already_done';
    // 'held' by another attempt (in flight, or a worker died mid-call) or an
    // earlier 'failed': the outcome is theirs, and repeating it could double it.
    if (claim !== 'claimed') return 'failed';

    try {
      const ctx = await this.context(event);
      const providerRef = await call(ctx);
      await this.ledger.finishAction(event.tenantId, event.commentId, action, {
        status: 'succeeded',
        providerRef,
      });
      return 'succeeded';
    } catch (error) {
      if (error instanceof CommentDeferredError) {
        await this.release(event, action, error.reason);
        throw error;
      }
      if (error instanceof MetaGraphError && error.isRateLimited) {
        await this.release(event, action, error.message);
        throw new CommentDeferredError(
          META_THROTTLE_BACKOFF_MS,
          `Meta throttled ${action} on ${event.channelAccountId}: ${error.message}`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `comment ${event.commentId}: ${action} failed and will not be retried: ${message}`,
        CommentActionExecutor.name,
      );
      await this.ledger.finishAction(event.tenantId, event.commentId, action, {
        status: 'failed',
        error: message.slice(0, 1000),
      });
      return 'failed';
    }
  }

  private async release(
    event: ActionEvent,
    action: CommentAction,
    reason: string,
  ): Promise<void> {
    await this.ledger.finishAction(event.tenantId, event.commentId, action, {
      status: 'released',
      error: reason.slice(0, 1000),
    });
  }

  private async context(event: ActionEvent): Promise<GraphContext> {
    const resolved = await this.channels.resolve(event.channelAccountId);
    // Throws SocialChannelReconnectRequiredError on a degraded channel; that
    // lands in run()'s catch as a `failed` action with the reason recorded.
    const pageAccessToken = await this.tokens.ensureFreshToken(
      event.channelAccountId,
    );
    return {
      pageId: resolved.pageId,
      pageAccessToken,
      surface: surfaceOf(event.channel),
    };
  }
}

/** Which product's comment edges to call. The page row is 'messenger'; its comments are Facebook comments. */
export function surfaceOf(channel: ChannelKind): GraphCommentSurface {
  return channel === 'instagram' ? 'instagram' : 'facebook';
}
