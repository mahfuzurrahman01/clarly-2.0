// Gulf T8 (D6): reads and writes of the comment ledger (`comment_events`) and
// the per-action claims (`comment_actions`). Every statement runs in the
// tenant's RLS transaction; the uniqueness guarantees live in the database
// (unique constraints + ON CONFLICT), never in a read-then-write here.
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  commentActions,
  commentEvents,
  type CommentAction,
  type CommentActionStatus,
  type CommentDecision,
  type CommentEventStatus,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { NormalizedCommentEvent } from '../meta-channel/meta-social-envelope.parser';

export type CommentEventRecord = typeof commentEvents.$inferSelect;
export type CommentActionRecord = typeof commentActions.$inferSelect;

export interface RecordedComment {
  /** Null when the row exists but is not this tenant's (RLS hides it). */
  id: string | null;
  isNew: boolean;
  status: CommentEventStatus | null;
}

export interface CommentPlanInput {
  intent: string;
  decision: CommentDecision;
  publicReplyText: string | null;
  privateReplyText: string | null;
}

/**
 * 'claimed': this caller now owns the action and must perform it.
 * 'held': another attempt holds the claim (in flight, or died mid-call).
 * 'succeeded' / 'failed': an earlier attempt finished.
 */
export type ClaimResult = 'claimed' | 'held' | 'succeeded' | 'failed';

@Injectable()
export class CommentLedgerService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * The replay guard: inserts the comment unless (channel, comment_id) is
   * already recorded. A replay returns `isNew: false` with the existing row's
   * status so the caller can re-queue one that never got past `received`.
   */
  async recordReceived(
    tenantId: string,
    comment: NormalizedCommentEvent,
  ): Promise<RecordedComment> {
    return this.tenantContext.withTenantTx(async (tx) => {
      const [inserted] = await tx
        .insert(commentEvents)
        .values({
          tenantId,
          channel: comment.channel,
          channelAccountId: comment.channelAccountId,
          commentId: comment.commentId,
          postId: comment.postId,
          parentId: comment.parentId,
          authorId: comment.authorId,
          authorName: comment.authorName,
          text: comment.text,
          mediaProductType: comment.mediaProductType,
          commentCreatedAt: comment.createdAt,
        })
        .onConflictDoNothing({
          target: [commentEvents.channel, commentEvents.commentId],
        })
        .returning({ id: commentEvents.id });
      if (inserted) return { id: inserted.id, isNew: true, status: 'received' };

      const [existing] = await tx
        .select({ id: commentEvents.id, status: commentEvents.status })
        .from(commentEvents)
        .where(
          and(
            eq(commentEvents.channel, comment.channel),
            eq(commentEvents.commentId, comment.commentId),
          ),
        )
        .limit(1);
      return {
        id: existing?.id ?? null,
        isNew: false,
        status: existing?.status ?? null,
      };
    }, tenantId);
  }

  async get(tenantId: string, id: string): Promise<CommentEventRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(commentEvents)
          .where(
            and(eq(commentEvents.tenantId, tenantId), eq(commentEvents.id, id)),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ?? null;
  }

  async savePlan(
    tenantId: string,
    id: string,
    plan: CommentPlanInput,
  ): Promise<void> {
    await this.update(tenantId, id, { ...plan, status: 'planned' });
  }

  async skip(
    tenantId: string,
    id: string,
    reason: string,
    intent: string | null = null,
  ): Promise<void> {
    await this.update(tenantId, id, {
      status: 'skipped',
      skipReason: reason,
      ...(intent ? { intent } : {}),
    });
  }

  async complete(tenantId: string, id: string): Promise<void> {
    await this.update(tenantId, id, { status: 'completed' });
  }

  /** D15b: the private reply went out; the thread now waits for the customer. */
  async recordPrivateReplySent(
    tenantId: string,
    id: string,
    sent: { recipientId: string; messageId: string; sentAt: Date },
  ): Promise<void> {
    await this.update(tenantId, id, {
      privateReplyRecipientId: sent.recipientId,
      privateReplyMessageId: sent.messageId,
      privateReplySentAt: sent.sentAt,
      threadState: 'awaiting_reply',
    });
  }

  /**
   * Claims (comment, action) BEFORE the Graph call. Succeeds on a fresh row,
   * or by taking over a `released` one (an attempt we know Meta never
   * performed). Any other existing row wins, and its status is returned.
   */
  async claimAction(
    tenantId: string,
    commentEventId: string,
    commentId: string,
    action: CommentAction,
  ): Promise<ClaimResult> {
    return this.tenantContext.withTenantTx(async (tx) => {
      const [claimed] = await tx
        .insert(commentActions)
        .values({ tenantId, commentEventId, commentId, action })
        .onConflictDoUpdate({
          target: [commentActions.commentId, commentActions.action],
          set: {
            status: 'claimed',
            error: null,
            attempts: sql`${commentActions.attempts} + 1`,
            updatedAt: new Date(),
          },
          setWhere: eq(commentActions.status, 'released'),
        })
        .returning({ id: commentActions.id });
      if (claimed) return 'claimed';

      const [existing] = await tx
        .select({ status: commentActions.status })
        .from(commentActions)
        .where(
          and(
            eq(commentActions.commentId, commentId),
            eq(commentActions.action, action),
          ),
        )
        .limit(1);
      // Invisible under RLS means another tenant holds it: never ours to run.
      if (!existing) return 'failed';
      return existing.status === 'claimed'
        ? 'held'
        : existing.status === 'succeeded'
          ? 'succeeded'
          : 'failed';
    }, tenantId);
  }

  async finishAction(
    tenantId: string,
    commentId: string,
    action: CommentAction,
    outcome: {
      status: Exclude<CommentActionStatus, 'claimed'>;
      providerRef?: string | null;
      error?: string | null;
    },
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(commentActions)
          .set({
            status: outcome.status,
            providerRef: outcome.providerRef ?? null,
            error: outcome.error ?? null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(commentActions.tenantId, tenantId),
              eq(commentActions.commentId, commentId),
              eq(commentActions.action, action),
            ),
          ),
      tenantId,
    );
  }

  async actionStatus(
    tenantId: string,
    commentId: string,
    action: CommentAction,
  ): Promise<CommentActionStatus | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ status: commentActions.status })
          .from(commentActions)
          .where(
            and(
              eq(commentActions.tenantId, tenantId),
              eq(commentActions.commentId, commentId),
              eq(commentActions.action, action),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0]?.status ?? null;
  }

  /** The console's recent-activity read, newest first, with each comment's actions. */
  async listRecent(
    tenantId: string,
    limit: number,
  ): Promise<{ event: CommentEventRecord; actions: CommentActionRecord[] }[]> {
    return this.tenantContext.withTenantTx(async (tx) => {
      const events = await tx
        .select()
        .from(commentEvents)
        .where(eq(commentEvents.tenantId, tenantId))
        .orderBy(desc(commentEvents.createdAt))
        .limit(limit);
      if (events.length === 0) return [];
      const actions = await tx
        .select()
        .from(commentActions)
        .where(
          and(
            eq(commentActions.tenantId, tenantId),
            inArray(
              commentActions.commentEventId,
              events.map((event) => event.id),
            ),
          ),
        );
      return events.map((event) => ({
        event,
        actions: actions.filter((a) => a.commentEventId === event.id),
      }));
    }, tenantId);
  }

  /**
   * D15b: the customer wrote back. Atomically moves every private-reply
   * thread waiting on this sender (on this account) to `replied` and returns
   * them, oldest first. Two concurrent DMs cannot both adopt a thread: the
   * `thread_state = 'awaiting_reply'` predicate is part of the UPDATE.
   */
  async adoptAwaitingThreads(
    tenantId: string,
    channelAccountId: string,
    recipientId: string,
  ): Promise<CommentEventRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(commentEvents)
          .set({ threadState: 'replied', updatedAt: new Date() })
          .where(
            and(
              eq(commentEvents.tenantId, tenantId),
              eq(commentEvents.channelAccountId, channelAccountId),
              eq(commentEvents.privateReplyRecipientId, recipientId),
              eq(commentEvents.threadState, 'awaiting_reply'),
            ),
          )
          .returning(),
      tenantId,
    );
    return [...rows].sort(
      (a, b) =>
        (a.privateReplySentAt?.getTime() ?? 0) -
        (b.privateReplySentAt?.getTime() ?? 0),
    );
  }

  async linkConversation(
    tenantId: string,
    ids: readonly string[],
    conversationId: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(commentEvents)
          .set({ conversationId, updatedAt: new Date() })
          .where(
            and(
              eq(commentEvents.tenantId, tenantId),
              inArray(commentEvents.id, [...ids]),
            ),
          ),
      tenantId,
    );
  }

  private async update(
    tenantId: string,
    id: string,
    patch: Partial<typeof commentEvents.$inferInsert>,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(commentEvents)
          .set({ ...patch, updatedAt: new Date() })
          .where(
            and(eq(commentEvents.tenantId, tenantId), eq(commentEvents.id, id)),
          ),
      tenantId,
    );
  }
}
