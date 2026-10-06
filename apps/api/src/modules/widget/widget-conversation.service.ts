// Clarly 2.0 S3: what a visitor sees — their own conversation, nothing else.
// The visitor id is the conversation's `customer_phone` on the `web` channel
// (conversations are unique per tenant + customer id; `web_<uuid>` cannot
// collide with a phone number or a Meta id).
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { conversations, messages } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { PublicWidgetMessage } from './widget.dto';

/** Enough history for a returning visitor; older turns stay in the console. */
const MAX_MESSAGES = 100;
const CLIENT_ID_PREFIX = 'web:';

/** The provider message id a widget message is ingested under, and back. */
export function widgetProviderMessageId(clientMessageId: string): string {
  return `${CLIENT_ID_PREFIX}${clientMessageId}`;
}
export function clientIdOf(bspMessageId: string | null): string | null {
  return bspMessageId?.startsWith(CLIENT_ID_PREFIX)
    ? bspMessageId.slice(CLIENT_ID_PREFIX.length)
    : null;
}

@Injectable()
export class WidgetConversationService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async messagesFor(
    tenantId: string,
    visitorId: string,
    after?: Date,
  ): Promise<PublicWidgetMessage[]> {
    return this.tenantContext.withTenantTx(async (tx) => {
      const [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            eq(conversations.customerPhone, visitorId),
            eq(conversations.channel, 'web'),
          ),
        )
        .limit(1);
      if (!conversation) return [];

      const rows = await tx
        .select({
          id: messages.id,
          role: messages.role,
          content: messages.content,
          bspMessageId: messages.bspMessageId,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, tenantId),
            eq(messages.conversationId, conversation.id),
            // Only what the visitor said and what the business said to them:
            // never internal rows (system templates, business-app echoes).
            inArray(messages.role, ['user', 'assistant', 'human_agent']),
            after ? gt(messages.createdAt, after) : undefined,
          ),
        )
        .orderBy(asc(messages.createdAt))
        .limit(MAX_MESSAGES);

      return rows
        .filter((r) => r.content.trim().length > 0)
        .map((r) => ({
          id: r.id,
          from:
            r.role === 'user' ? ('visitor' as const) : ('business' as const),
          text: r.content,
          clientMessageId:
            r.role === 'user' ? clientIdOf(r.bspMessageId) : null,
          createdAt: r.createdAt,
        }));
    }, tenantId);
  }
}
