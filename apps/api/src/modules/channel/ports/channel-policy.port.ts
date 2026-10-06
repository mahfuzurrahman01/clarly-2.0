// Channel (ChannelModule, Feature 16): the messaging-window abstraction that
// replaces WhatsApp's hardcoded 24h rule (D9 / `customer-service-window.ts`).
//
// Before this, "can we send a free-form reply right now" was answered by one
// pure function that knew only WhatsApp's rule, and every caller (the inbox
// read path, the human-reply send path, the respond path) called it
// directly. Adding Messenger and Instagram to that shape would have meant an
// `if (channel === ...)` at each of those call sites — three copies of the
// same branch, drifting independently. Instead each channel owns its rule
// here, callers ask `ChannelPolicyRegistry.for(channel).evaluate(...)`, and
// the rules stay in one file per channel.
//
// The three rules, as of Meta's platform docs at time of writing:
//
//   whatsapp  — 24h from last inbound. Outside: an APPROVED TEMPLATE only.
//   messenger — 24h from last inbound. Outside: a MESSAGE TAG
//               (CONFIRMED_EVENT_UPDATE / POST_PURCHASE_UPDATE /
//               ACCOUNT_UPDATE), or HUMAN_AGENT which buys 7 days.
//   instagram — 24h from last inbound. Outside: HUMAN_AGENT only — Instagram
//               does not accept the generic Messenger tags.
//
// None of these are hardcoded anywhere else. A caller that wants to know
// what it may do outside the window reads `outOfWindowOptions`; it never
// infers it from the channel name.
import type { ChannelKind } from './channel-kind';

/**
 * What a channel still permits once its free-form window has shut.
 *
 * 'template'    — a pre-registered, provider-approved template (WhatsApp).
 * 'message_tag' — a provider-defined tag asserting the message is a
 *                 permitted transactional exception (Messenger).
 * 'human_agent' — the HUMAN_AGENT tag: a person, not a bot, is replying,
 *                 which extends the window to 7 days (Messenger, Instagram).
 */
export const OUT_OF_WINDOW_OPTIONS = [
  'template',
  'message_tag',
  'human_agent',
] as const;
export type OutOfWindowOption = (typeof OUT_OF_WINDOW_OPTIONS)[number];

export interface MessagingWindow {
  channel: ChannelKind;
  /** A free-form reply is accepted right now. */
  open: boolean;
  /** When the free-form window shuts. Already in the past when `open` is false. */
  expiresAt: Date;
  /** What is still permitted once `open` is false. Empty means nothing is — do not send. */
  outOfWindowOptions: readonly OutOfWindowOption[];
}

export interface WindowEvaluation {
  lastInboundAt: Date;
  now: Date;
  /**
   * Whether the message about to be sent is being written by a PERSON on the
   * tenant's team rather than the agent. Only Messenger/Instagram care: it is
   * the precondition for the HUMAN_AGENT tag, and claiming it for an
   * automated send would be a policy violation against Meta, not merely a
   * failed request. Defaults to false — the agent is the common case, and a
   * default of true would make every automated send quietly claim it.
   */
  humanAgent?: boolean;
}

/**
 * Abstract class, not an interface — same DI-token-and-contract-in-one
 * pattern as `ChannelAdapter`/`BspAdapter`, so a policy can be injected and
 * faked in a test without a separate token constant.
 */
export abstract class ChannelPolicy {
  abstract readonly channel: ChannelKind;

  /** Hours of free-form window after the customer's last inbound message. */
  abstract readonly windowHours: number;

  abstract evaluate(input: WindowEvaluation): MessagingWindow;

  /**
   * The tag to put on the wire for an out-of-window send, or null when this
   * channel has no tag mechanism (WhatsApp — it uses templates instead).
   *
   * Returning null is NOT "send it untagged": the caller must already have
   * established from `evaluate()` that a send is permitted at all.
   */
  abstract outOfWindowTag(input: WindowEvaluation): string | null;
}

/** Shared by all three implementations — the arithmetic is genuinely identical, only the constants and the exception rules differ. */
export function windowExpiry(lastInboundAt: Date, windowHours: number): Date {
  return new Date(lastInboundAt.getTime() + windowHours * 60 * 60 * 1000);
}
