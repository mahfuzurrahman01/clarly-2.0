/**
 * BullMQ queue for fetching inbound media (F13; every channel since Gulf T6).
 *
 * A queue rather than an inline fetch on the webhook path, for T11's reason:
 * the ACK budget is under a second and a media fetch is one or two network
 * round-trips plus however many megabytes the customer sent. Doing it inline
 * would make the webhook time out and Meta redeliver, which is the failure
 * T11 exists to prevent.
 *
 * Urgency still matters: WhatsApp media ids and Messenger/Instagram CDN urls
 * are both short-lived, so this queue should be worked promptly rather than
 * treated as background cleanup.
 */
import { z } from 'zod';
import type { InboundMediaSource } from '../channel/ports/channel-adapter.port';
import { CHANNELS, type ChannelKind } from '../channel/ports/channel-kind';

export const MEDIA_DOWNLOAD_QUEUE = 'media-download';

export interface MediaUnderstandingRequest {
  kind: 'image' | 'voice';
  /** What the channel declared, '' when it declared nothing (Messenger/Instagram never do). */
  mimeType: string;
  /** The provider's own message id (`wamid.*` / `mid.*`) — same naming as the rest of the channel layer since F16. */
  providerMessageId: string;
  /** The customer's channel-scoped id — the respond path keys the conversation on it. */
  from: string;
  /** The caption the customer typed alongside the attachment, '' when there was none. */
  caption: string;
}

/** What the queue carries from Gulf T6 on. */
export interface MediaDownloadJobData {
  tenantId: string;
  /** The `messages` row the bytes belong to — the job's whole purpose is to complete it. */
  messageId: string;
  /** Selects the adapter that dereferences `source` (`ChannelRegistry.for(channel)`). */
  channel: ChannelKind;
  /** WhatsApp `phone_number_id`, Facebook page id, or Instagram account id. */
  channelAccountId: string;
  /** `{ mediaId }` on WhatsApp, `{ mediaUrl }` on Messenger/Instagram. */
  source: InboundMediaSource;
  /** For naming the stored object and the eventual download; metadata only, never part of a storage path. */
  filename: string | null;
  /**
   * F17: set when the attachment is an image or voice note the agent is
   * expected to ANSWER, not just store for a human. Absent means "store it;
   * the escalation ticket already exists".
   */
  understanding?: MediaUnderstandingRequest;
}

/**
 * The pre-T6 shape: WhatsApp only, `phoneNumberId` + `mediaId`. Jobs already
 * sitting in Redis at deploy time still have it, so the worker reads both.
 * Remove once a release has drained the queue.
 */
export interface LegacyMediaDownloadJobData {
  tenantId: string;
  messageId: string;
  phoneNumberId: string;
  mediaId: string;
  filename: string | null;
  understanding?: MediaUnderstandingRequest;
}

const understandingSchema = z.object({
  kind: z.enum(['image', 'voice']),
  mimeType: z.string(),
  providerMessageId: z.string().min(1),
  from: z.string().min(1),
  caption: z.string(),
});

const sourceSchema = z.union([
  z.object({ mediaId: z.string().min(1) }).strict(),
  z.object({ mediaUrl: z.string() }).strict(),
]);

const currentSchema = z.object({
  tenantId: z.string().min(1),
  messageId: z.string().min(1),
  channel: z.enum(CHANNELS),
  channelAccountId: z.string().min(1),
  source: sourceSchema,
  filename: z.string().nullable(),
  understanding: understandingSchema.optional(),
});

const legacySchema = z.object({
  tenantId: z.string().min(1),
  messageId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  mediaId: z.string().min(1),
  filename: z.string().nullable(),
  understanding: understandingSchema.optional(),
});

/**
 * Job data comes back out of Redis, so it is parsed rather than cast. Returns
 * the current shape for either input, or null when it is neither.
 */
export function parseMediaDownloadJob(
  data: unknown,
): MediaDownloadJobData | null {
  const current = currentSchema.safeParse(data);
  if (current.success) return current.data;

  const legacy = legacySchema.safeParse(data);
  if (!legacy.success) return null;
  const { phoneNumberId, mediaId, ...rest } = legacy.data;
  return {
    ...rest,
    channel: 'whatsapp',
    channelAccountId: phoneNumberId,
    source: { mediaId },
  };
}
