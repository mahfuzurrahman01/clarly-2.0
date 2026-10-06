import type { HandoverState, MessageRole } from '../persistence/drizzle/schema';
import type { ChannelKind } from '../channel/ports/channel-kind';

export interface ConversationRecord {
  id: string;
  tenantId: string;
  /** Feature 16: which channel this thread lives on. Part of its identity, and what the unified inbox renders a badge from. */
  channel: ChannelKind;
  /** The customer's channel-scoped identity. NOT always a phone number — a PSID on Messenger, an IGSID on Instagram. */
  customerPhone: string;
  /** The channel ACCOUNT this conversation arrived on — a WhatsApp `phone_number_id`, a Facebook page id, or an Instagram account id. Null for conversations created before it was recorded. */
  channelAccountId: string | null;
  lastInboundAt: Date;
  handoverState: HandoverState;
  handoverAt: Date | null;
  handoverUserId: string | null;
  /** When this handover's one holding reply was sent; null if not yet sent. */
  handoverHoldingReplyAt: Date | null;
  rollingSummary: string | null;
  summarizedThroughMessageCount: number;
}

export interface RecentMessage {
  role: MessageRole;
  content: string;
}

export interface InboundMessageToRecord {
  /** The provider's own message id (`wamid.*` on WhatsApp, `mid.*` on Messenger/Instagram). */
  providerMessageId: string;
  text: string;
}
