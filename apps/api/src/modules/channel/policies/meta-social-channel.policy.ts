// Channel (ChannelModule, Feature 16): Messenger's and Instagram's messaging
// windows.
//
// The two share their arithmetic (24h standard window, 7 days under the
// HUMAN_AGENT tag) and differ in exactly one thing — which out-of-window
// exceptions the platform accepts — so they are one base class with one
// differing field rather than two near-identical files. That difference is
// declared as DATA (`outOfWindowOptions`), not as a branch, which is the
// whole point of the ChannelPolicy abstraction.
//
// The 7-day HUMAN_AGENT extension is genuinely a *different window*, not a
// tag applied to a shut one: inside those 7 days a human's reply is an
// ordinary free-form send that Meta accepts, tagged. So `evaluate()` widens
// the window when `humanAgent` is set rather than reporting `open: false`
// with an exception — reporting it shut would make the console tell a
// support agent they cannot reply when they demonstrably can.
import { Injectable } from '@nestjs/common';
import type { ChannelKind } from '../ports/channel-kind';
import {
  ChannelPolicy,
  windowExpiry,
  type MessagingWindow,
  type OutOfWindowOption,
  type WindowEvaluation,
} from '../ports/channel-policy.port';

/** Meta's standard messaging window for Messenger and Instagram. */
export const META_STANDARD_WINDOW_HOURS = 24;

/** Meta's HUMAN_AGENT extension: 7 days for a human-authored reply. */
export const META_HUMAN_AGENT_WINDOW_HOURS = 7 * 24;

export const HUMAN_AGENT_TAG = 'HUMAN_AGENT';

/**
 * Messenger's transactional tags, in the order we would prefer them. NOT
 * used automatically: nothing in the respond path is entitled to assert
 * "this is a post-purchase update" on a tenant's behalf, so the send path
 * only ever reaches for HUMAN_AGENT (which we can honestly assert, because
 * we know whether a person typed the message). These are exported for the
 * campaign/template surfaces that will need to name one explicitly.
 */
export const MESSENGER_MESSAGE_TAGS = [
  'CONFIRMED_EVENT_UPDATE',
  'POST_PURCHASE_UPDATE',
  'ACCOUNT_UPDATE',
] as const;

abstract class MetaSocialChannelPolicy extends ChannelPolicy {
  readonly windowHours = META_STANDARD_WINDOW_HOURS;

  protected abstract readonly exceptions: readonly OutOfWindowOption[];

  evaluate(input: WindowEvaluation): MessagingWindow {
    const hours = input.humanAgent
      ? META_HUMAN_AGENT_WINDOW_HOURS
      : this.windowHours;
    const expiresAt = windowExpiry(input.lastInboundAt, hours);

    return {
      channel: this.channel,
      open: input.now.getTime() < expiresAt.getTime(),
      expiresAt,
      outOfWindowOptions: this.exceptions,
    };
  }

  /**
   * A human's reply inside the 7-day extension must carry HUMAN_AGENT or
   * Meta rejects it — the extension is granted BY the tag, it is not an
   * ambient property of the conversation. An automated send never gets one:
   * the agent has no honest tag to claim, and inventing one is a policy
   * violation rather than a rejected request.
   */
  outOfWindowTag(input: WindowEvaluation): string | null {
    if (!input.humanAgent) return null;
    return this.exceptions.includes('human_agent') ? HUMAN_AGENT_TAG : null;
  }
}

@Injectable()
export class MessengerChannelPolicy extends MetaSocialChannelPolicy {
  readonly channel: ChannelKind = 'messenger';
  protected readonly exceptions: readonly OutOfWindowOption[] = [
    'message_tag',
    'human_agent',
  ];
}

@Injectable()
export class InstagramChannelPolicy extends MetaSocialChannelPolicy {
  readonly channel: ChannelKind = 'instagram';
  // No 'message_tag': Instagram does not accept Messenger's transactional
  // tags. Listing them here would have the console offering a support agent
  // an out-of-window option that always fails at send time.
  protected readonly exceptions: readonly OutOfWindowOption[] = ['human_agent'];
}
