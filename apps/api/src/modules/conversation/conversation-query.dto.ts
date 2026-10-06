// Product shell (ConversationModule): the read-side contract behind the
// console inbox (`InboxModule`). Kept separate from `conversation.dto.ts`,
// which is the agent-side write/working-memory contract — the two evolve
// for different reasons (one follows D7's prompt assembly, this one
// follows what a human needs to audit a conversation).
import type {
  HandoverState,
  MediaStatus,
  MessageDeliveryStatus,
  MessageRole,
} from '../persistence/drizzle/schema';
import type { ChannelKind } from '../channel/ports/channel-kind';

/** One row of the inbox list. `lastMessage` is the preview the list renders; null when every message of the conversation has been purged (T16) but the conversation row itself has not yet expired. */
export interface ConversationSummary {
  id: string;
  /** Feature 16: which channel this thread arrived on. The unified inbox renders all three in one list and uses this for the badge/filter — it is display data, never a code path. */
  channel: ChannelKind;
  /** The customer's channel-scoped identity. NOT always a phone number: a PSID on Messenger, an IGSID on Instagram. */
  customerPhone: string;
  /** From `customers` (T13), left-joined on (tenant, phone) — null when no profile row exists yet. */
  customerName: string | null;
  lastInboundAt: Date;
  lastMessage: { role: MessageRole; content: string; createdAt: Date } | null;
  messageCount: number;
  /** True when at least one ticket references this conversation — i.e. the agent handed it to a human at some point. */
  escalated: boolean;
  /** Feature 18: the customer's label (hot/warm/cold), null when no label exists yet. */
  label: string | null;
}

/** The thread header: everything the transcript view needs that is not a message. */
export interface ConversationDetail {
  id: string;
  channel: ChannelKind;
  customerPhone: string;
  customerName: string | null;
  lastInboundAt: Date;
  rollingSummary: string | null;
  messageCount: number;
  escalated: boolean;
  createdAt: Date;
  /** Who is answering right now — the agent, or a person who took over. */
  handoverState: HandoverState;
  handoverAt: Date | null;
  handoverUserId: string | null;
  /**
   * This CHANNEL's messaging window, evaluated when this was read (Feature
   * 16 — it was WhatsApp's 24 hours unconditionally before).
   *
   * Free-form replies are rejected by the provider once it shuts, so the
   * console must show this rather than let a human type into a dead box.
   * Evaluated with `humanAgent: true`, because the only person who reads this
   * is a human about to reply — which is what earns Messenger's and
   * Instagram's 7-day HUMAN_AGENT extension.
   *
   * `outOfWindowOptions` says what is still possible once `open` is false:
   * 'template' (WhatsApp), 'message_tag' (Messenger), 'human_agent'
   * (Messenger/Instagram). Empty means nothing is.
   */
  replyWindow: {
    open: boolean;
    expiresAt: Date;
    outOfWindowOptions: readonly ('template' | 'message_tag' | 'human_agent')[];
  };
  /** F10: what the agent has collected, so a human never re-asks what the customer already answered. */
  intake: { key: string; label: string; value: string; scope: string }[];
}

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: Date;
  /** Outbound only: whether the message reached the customer. Null on inbound rows and on outbound rows the BSP has not reported on yet. */
  deliveryStatus: MessageDeliveryStatus | null;
  /** Why an outbound message failed, verbatim from the BSP. */
  deliveryError: string | null;
  /** Which team member sent it, for role='human_agent' rows. */
  authorUserId: string | null;
  /** A human's verdict on this reply, when someone has given one. */
  feedback: { rating: 'up' | 'down'; note: string | null } | null;
  /** The attachment the customer sent, when there was one (F13). Null on every message that had none. */
  media: ConversationMessageMedia | null;
}

/**
 * An inbound attachment, as far as the reader is concerned.
 *
 * The bytes are not inlined — a transcript page would become megabytes — so
 * this describes the attachment and the caller fetches it separately when the
 * status says there is something to fetch.
 */
export interface ConversationMessageMedia {
  /** 'pending' means the bytes are still being fetched; 'failed' and 'too_large' mean they are not coming, and `error` says why. */
  status: MediaStatus;
  mimeType: string | null;
  sizeBytes: number | null;
  filename: string | null;
  error: string | null;
  /**
   * F17 follow-up: the ASR transcript for a voice note, once the agent turn
   * that answered it has run. Null for every non-voice attachment, and for a
   * voice note that escalated before an agent turn ever computed one.
   */
  transcript: string | null;
}

export interface ListConversationsFilters {
  /** Substring match against `customer_phone` — the console's search box, not an exact-id lookup. */
  phone?: string;
  /** Inclusive lower/upper bounds on `last_inbound_at`. */
  from?: Date;
  to?: Date;
  /** Restrict to conversations that did (true) or did not (false) produce a ticket. */
  escalated?: boolean;
}

/** Keyset page. `nextCursor` is null on the last page — the console stops when it sees that, never on a short page (a filtered page can be short and still have more behind it). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
