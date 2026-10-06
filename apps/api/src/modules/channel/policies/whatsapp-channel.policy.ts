// Channel (ChannelModule, Feature 16 / D9): WhatsApp's 24h customer service
// window, expressed as a ChannelPolicy.
//
// The rule itself is unchanged and still delegates to
// `whatsapp/customer-service-window.ts` — that pure function is what the
// inbox read path and the F12 template send path already call, and forking
// the arithmetic into a second implementation would let the two drift.
// This class adds only what the abstraction needs: the channel tag and the
// out-of-window vocabulary ("a template, and nothing else").
import { Injectable } from '@nestjs/common';
import {
  CUSTOMER_SERVICE_WINDOW_HOURS,
  customerServiceWindow,
} from '../../whatsapp/customer-service-window';
import type { ChannelKind } from '../ports/channel-kind';
import {
  ChannelPolicy,
  type MessagingWindow,
  type WindowEvaluation,
} from '../ports/channel-policy.port';

@Injectable()
export class WhatsappChannelPolicy extends ChannelPolicy {
  readonly channel: ChannelKind = 'whatsapp';
  readonly windowHours = CUSTOMER_SERVICE_WINDOW_HOURS;

  evaluate(input: WindowEvaluation): MessagingWindow {
    const { open, expiresAt } = customerServiceWindow(
      input.lastInboundAt,
      input.now,
    );
    return {
      channel: this.channel,
      open,
      expiresAt,
      // A human agent gets no extension on WhatsApp: outside 24 hours a
      // person types the same rejected free-form message the agent would.
      // Their only route is an approved template, exactly like the agent's.
      outOfWindowOptions: ['template'],
    };
  }

  /** WhatsApp has no tag mechanism at all — templates are a different API call, not a tagged text send. */
  outOfWindowTag(): string | null {
    return null;
  }
}
