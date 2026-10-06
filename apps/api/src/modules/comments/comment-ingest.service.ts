// Gulf T8 (F23, D6): the webhook half of comment automation. Called by the
// `/webhooks/meta` controller AFTER WebhookIngestService has verified the
// `X-Hub-Signature-256` over the same raw body — one route, one signature
// check, two branches of the same envelope.
//
// ACK-fast like the DM path: parse, drop what never triggers, record the
// ledger row (the replay guard), enqueue. No classification, no model call
// and no Graph call happens here.
//
//   verb != add            -> dropped (D6: edits and removals never trigger)
//   author = the account   -> dropped (D6: our own replies are echoed back as
//                             feed/comment events; answering them would loop)
//   unknown account        -> dropped (a page still subscribed after being
//                             disconnected; a 404 would make Meta retry and
//                             eventually disable the whole webhook)
//   closed workspace       -> dropped
//   replayed comment       -> duplicate (re-queued only if it never started)
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AppLoggerService } from '../core';
import {
  parseMetaSocialComments,
  type NormalizedCommentEvent,
} from '../meta-channel/meta-social-envelope.parser';
import {
  SocialChannelResolutionService,
  type ResolvedSocialChannel,
} from '../meta-channel/social-channel-resolution.service';
import { UnknownSocialChannelError } from '../meta-channel/social-channel.errors';
import { TenantStatusService } from '../tenant-context/tenant-status.service';
import {
  COMMENT_AUTOMATION_JOB,
  COMMENT_AUTOMATION_QUEUE,
  commentJobId,
  type CommentAutomationJobData,
} from './comment-automation.queue';
import { CommentLedgerService } from './comment-ledger.service';

export type CommentIngestOutcome =
  | 'enqueued'
  | 'requeued'
  | 'duplicate'
  | 'ignored_verb'
  | 'own_comment'
  | 'unknown_account'
  | 'workspace_closed';

export interface CommentIngestResult {
  commentId: string;
  outcome: CommentIngestOutcome;
}

@Injectable()
export class CommentIngestService {
  constructor(
    private readonly resolution: SocialChannelResolutionService,
    private readonly tenantStatus: TenantStatusService,
    private readonly ledger: CommentLedgerService,
    @InjectQueue(COMMENT_AUTOMATION_QUEUE)
    private readonly queue: Queue<CommentAutomationJobData>,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * The body MUST already be signature-verified by the caller.
   * @throws on a malformed envelope (the DM parser would already have thrown
   *   on the same body).
   */
  async ingest(rawBody: string | Buffer): Promise<CommentIngestResult[]> {
    const results: CommentIngestResult[] = [];
    for (const comment of parseMetaSocialComments(rawBody)) {
      results.push({
        commentId: comment.commentId,
        outcome: await this.ingestOne(comment),
      });
    }
    return results;
  }

  private async ingestOne(
    comment: NormalizedCommentEvent,
  ): Promise<CommentIngestOutcome> {
    if (comment.verb !== 'add') return 'ignored_verb';
    if (comment.authorId === comment.channelAccountId) return 'own_comment';

    const resolved = await this.resolveAccount(comment);
    if (!resolved) return 'unknown_account';
    // The linked page commenting on its own IG media is still us.
    if (comment.authorId === resolved.pageId) return 'own_comment';
    if (await this.tenantStatus.isClosed(resolved.tenantId)) {
      return 'workspace_closed';
    }

    const recorded = await this.ledger.recordReceived(
      resolved.tenantId,
      comment,
    );
    if (!recorded.id) return 'duplicate';
    if (!recorded.isNew && recorded.status !== 'received') return 'duplicate';

    // A replay of a comment that never got past `received` (the first
    // delivery recorded it, then failed to enqueue) is enqueued again. The
    // job id is the ledger id, so a job that does exist is not duplicated.
    await this.queue.add(
      COMMENT_AUTOMATION_JOB,
      { tenantId: resolved.tenantId, commentEventId: recorded.id },
      { jobId: commentJobId(recorded.id) },
    );
    return recorded.isNew ? 'enqueued' : 'requeued';
  }

  private async resolveAccount(
    comment: NormalizedCommentEvent,
  ): Promise<ResolvedSocialChannel | null> {
    try {
      return await this.resolution.resolve(comment.channelAccountId);
    } catch (error) {
      if (!(error instanceof UnknownSocialChannelError)) throw error;
      this.logger.warn(
        `comment ${comment.commentId} arrived for unconnected Meta account ${comment.channelAccountId}; ignored`,
        CommentIngestService.name,
      );
      return null;
    }
  }
}
