// EmailModule (gap #3): bound when EMAIL_PROVIDER is 'none' (the default —
// no mail provider configured in this environment).
//
// Fails closed. `isEnabled()` returns false so callers skip composing, and
// `send()` throws rather than resolving: a no-op that quietly resolved would
// make an undelivered escalation alert indistinguishable from a delivered
// one, which is the exact failure this feature exists to remove.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import {
  EmailSender,
  type EmailMessage,
  type EmailSendResult,
} from './ports/email-sender.port';

@Injectable()
export class NoopEmailSender extends EmailSender {
  constructor(private readonly logger: AppLoggerService) {
    super();
  }

  isEnabled(): boolean {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call; async to satisfy the port contract.
  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.logger.warn(
      `NoopEmailSender: no mail provider configured (EMAIL_PROVIDER=none) — ` +
        `would have sent "${message.subject}" to ${message.to.length} recipient(s). ` +
        `Set EMAIL_PROVIDER=resend with RESEND_API_KEY and EMAIL_FROM_ADDRESS to deliver it.`,
      'NoopEmailSender',
    );
    throw new Error(
      'NoopEmailSender: no mail provider is configured (EMAIL_PROVIDER=none) — nothing was sent.',
    );
  }
}
