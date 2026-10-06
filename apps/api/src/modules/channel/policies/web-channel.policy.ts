import { Injectable } from '@nestjs/common';
import type { ChannelKind } from '../ports/channel-kind';
import {
  ChannelPolicy,
  type MessagingWindow,
  type WindowEvaluation,
} from '../ports/channel-policy.port';

/** Ten years: "no window" expressed in the port's own terms. */
const NO_WINDOW_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * Clarly 2.0 S3: the website widget has no platform messaging window. A reply
 * written hours later is still stored and shown the next time the visitor
 * opens the widget — there is no Meta in between to refuse it.
 */
@Injectable()
export class WebChannelPolicy extends ChannelPolicy {
  readonly channel: ChannelKind = 'web';
  readonly windowHours = Number.POSITIVE_INFINITY;

  evaluate(input: WindowEvaluation): MessagingWindow {
    return {
      channel: this.channel,
      open: true,
      expiresAt: new Date(input.now.getTime() + NO_WINDOW_MS),
      outOfWindowOptions: [],
    };
  }

  outOfWindowTag(): string | null {
    return null;
  }
}
