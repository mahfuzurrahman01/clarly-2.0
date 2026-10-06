import type { EscalationReason } from '@repo/errors';
import type { ConversationCloseReason } from '../persistence/drizzle/conversation-outcomes.table';

export interface ConversationOutcomeRecord {
  id: string;
  tenantId: string;
  conversationId: string;
  escalated: boolean;
  escalationReason: EscalationReason | null;
  closedAt: Date;
  closeReason: ConversationCloseReason;
}
