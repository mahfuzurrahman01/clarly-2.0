// Product shell (InboxModule): recording whether an agent reply was any good.
import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  answerFeedback,
  messages,
  type FeedbackRating,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';

@Injectable()
export class AnswerFeedbackService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Records (or replaces) the rating on one reply.
   *
   * Upsert, not insert: rating the same message twice is someone changing
   * their mind, and stacking rows would turn one opinion into a vote count
   * that nobody cast.
   */
  async rate(input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    rating: FeedbackRating;
    note: string | null;
    userId: string;
  }): Promise<void> {
    await this.requireAgentMessage(
      input.tenantId,
      input.conversationId,
      input.messageId,
    );

    const values = {
      rating: input.rating,
      note: input.note,
      ratedBy: input.userId,
      updatedAt: new Date(),
    };

    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(answerFeedback)
          .values({
            tenantId: input.tenantId,
            messageId: input.messageId,
            ...values,
          })
          .onConflictDoUpdate({
            target: [answerFeedback.tenantId, answerFeedback.messageId],
            set: values,
          }),
      input.tenantId,
    );
  }

  /** Clearing is distinct from thumbs-down: "I have no opinion" must not read as "this was wrong" in an eval corpus. */
  async clear(input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
  }): Promise<void> {
    await this.requireAgentMessage(
      input.tenantId,
      input.conversationId,
      input.messageId,
    );

    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .delete(answerFeedback)
          .where(
            and(
              eq(answerFeedback.messageId, input.messageId),
              eq(answerFeedback.tenantId, input.tenantId),
            ),
          ),
      input.tenantId,
    );
  }

  /**
   * The message must exist, belong to this conversation, and be one the AGENT
   * produced. Rating a customer's own message, or a teammate's reply, would
   * put noise into the corpus this exists to build.
   */
  private async requireAgentMessage(
    tenantId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.id, messageId),
              eq(messages.conversationId, conversationId),
              eq(messages.role, 'assistant'),
              eq(messages.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );

    if (rows.length === 0) {
      throw new NotFoundException(
        `No agent reply ${messageId} in conversation ${conversationId}`,
      );
    }
  }
}
