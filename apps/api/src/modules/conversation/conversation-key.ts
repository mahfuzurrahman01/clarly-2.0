import {
  DEFAULT_CHANNEL,
  type ChannelKind,
} from '../channel/ports/channel-kind';

// T10/D8: the stable per-thread key both the advisory lock and burst
// coalescing key off. No `conversations` table exists yet (A7, a later
// task — not in Feature 3's scope) so this is a synthetic key, not a
// foreign key to a real row: a WhatsApp "conversation" is, for T10's
// purposes, uniquely identified by (tenantId, customer phone number)
// regardless of whether a formal conversation entity exists to back it.
export function buildConversationKey(
  tenantId: string,
  customerPhone: string,
  /**
   * Feature 16: which channel the thread is on.
   *
   * Part of the key, and it has to be. Both the T10 advisory lock and the
   * burst-coalescing window are per-thread, and the same customer messaging a
   * tenant on WhatsApp and on Instagram at once is two threads — a shared key
   * would serialise them against each other and, worse, coalesce a WhatsApp
   * message and an Instagram message into a single turn answered on one of
   * the two channels.
   *
   * Defaults to 'whatsapp' so pre-Feature-16 keys are byte-identical: an
   * in-flight lock or debounce window must not be orphaned by a deploy.
   */
  channel: ChannelKind = DEFAULT_CHANNEL,
): string {
  return channel === DEFAULT_CHANNEL
    ? `${tenantId}:${customerPhone}`
    : `${tenantId}:${channel}:${customerPhone}`;
}
