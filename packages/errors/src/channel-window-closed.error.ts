import { AgentError } from './agent-error';

/**
 * Feature 16: the channel-agnostic successor to `WAWindowClosedError`.
 *
 * Every messaging channel Meta operates has a *messaging window* — a period
 * after the customer's last inbound message during which a free-form reply
 * is accepted — and each one closes on its own rules with its own set of
 * exceptions:
 *
 *   - WhatsApp  — 24h; outside it, only a pre-approved template (D9).
 *   - Messenger — 24h; outside it, only a message *tag*
 *     (CONFIRMED_EVENT_UPDATE / POST_PURCHASE_UPDATE / ACCOUNT_UPDATE), or
 *     HUMAN_AGENT which extends the window to 7 days.
 *   - Instagram — 24h; outside it, HUMAN_AGENT only (Instagram does not
 *     accept the generic Messenger tags).
 *
 * `WAWindowClosedError` is deliberately left in place and still registered:
 * it is the WhatsApp *specialisation* of this condition and D13's stored
 * `escalation_reason` for all three is still `WA_WINDOW_CLOSED`, so nothing
 * downstream (metrics, the console's escalation labels) has to learn a new
 * value to read a Messenger escalation.
 */
export class ChannelWindowClosedError extends AgentError {
  /**
   * Which channel's window shut — 'whatsapp' | 'messenger' | 'instagram'.
   *
   * Free-form (and nullable) on purpose: @repo/errors must not depend on the
   * API's channel enum, and every sibling in this registry is constructible
   * with no arguments — the T1 registry test relies on that uniformity.
   */
  public readonly channel: string | null;

  constructor(channel: string | null = null, message?: string) {
    super(
      'CHANNEL_WINDOW_CLOSED',
      message ??
        `The ${channel ?? 'messaging'} window is closed for this conversation.`,
    );
    this.channel = channel;
  }
}
