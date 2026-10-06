import type { ChannelKind } from '../channel/ports/channel-kind';

/**
 * F17: an attachment already fetched and stored, ready for the turn to read.
 *
 * A reference, never the bytes: a BullMQ payload is JSON in Redis, and putting
 * a multi-megabyte image in one would be a memory and serialization cost paid
 * on every retry.
 */
export interface CoalescedMediaRef {
  /** The `messages` row the attachment belongs to. */
  messageId: string;
  kind: 'image' | 'voice';
  /** The mime type STORAGE observed — it describes the bytes we actually hold, not what the webhook declared. */
  mimeType: string;
  storageKey: string;
}

export interface CoalescedMessage {
  /** The provider's own message id (`wamid.*` on WhatsApp, `mid.*` on Messenger/Instagram). */
  providerMessageId: string;
  text: string;
  /** F17: present when this message carried an image or voice note the agent is expected to answer. */
  media?: CoalescedMediaRef;
}

/** T10: one coalesced turn's worth of inbound messages — what actually lands on the `respond-path` queue once BurstCoalescingService's debounce window elapses. Replaces the old one-message-per-job shape (RespondPathJobData, WebhookModule) as the queue's real payload. */
export interface CoalescedRespondJobData {
  tenantId: string;
  /**
   * Feature 16: which channel this burst arrived on.
   *
   * OPTIONAL for exactly the same reason `channelAccountId` is: a queue
   * payload outlives a deploy, and jobs enqueued by the previous version are
   * still in Redis at cutover. Those are read as 'whatsapp', which is what
   * every pre-Feature-16 job in fact was — a default that is a statement of
   * historical fact, not a guess.
   */
  channel?: ChannelKind;
  /**
   * The channel ACCOUNT the burst arrived on, used to send the reply back out
   * the same account. OPTIONAL because a queue payload outlives a deploy:
   * jobs enqueued before outbound send existed carry no account id at all.
   * The processor logs and skips the send for those rather than crashing — a
   * self-clearing condition, bounded by one debounce window.
   */
  channelAccountId?: string;
  from: string;
  /** In arrival order — oldest first. Always non-empty. */
  messages: CoalescedMessage[];
}
