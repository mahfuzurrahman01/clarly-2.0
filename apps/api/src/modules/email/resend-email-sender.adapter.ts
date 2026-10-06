// EmailModule (gap #3): the real EmailSender binding, over Resend's HTTP API.
//
// Plain `fetch` rather than the `resend` SDK, matching every other outbound
// integration in this app (the BSP adapters, the LLM providers): the API is
// one POST, and a dependency that wraps one POST is a supply-chain surface
// and a version to keep current for no gain.
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import {
  EmailSender,
  type EmailMessage,
  type EmailSendResult,
} from './ports/email-sender.port';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** Mail is never on a request path a customer is waiting on, but a hung socket must not hold a worker open either. */
const REQUEST_TIMEOUT_MS = 10_000;

interface ResendResponseBody {
  id?: string;
  message?: string;
  name?: string;
}

@Injectable()
export class ResendEmailSender extends EmailSender {
  constructor(private readonly config: AppConfigService) {
    super();
  }

  isEnabled(): boolean {
    return true;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (message.to.length === 0) {
      throw new Error(
        'ResendEmailSender: refusing to send with no recipients.',
      );
    }

    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.config.emailFromAddress,
        to: [...message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // Read the body before branching: Resend puts the reason for a refusal
    // (unverified sender, suppressed recipient) in it, and that reason is the
    // whole difference between a fixable misconfiguration and a mystery.
    const body = (await response
      .json()
      .catch(() => null)) as ResendResponseBody | null;

    if (!response.ok) {
      throw new Error(
        `ResendEmailSender: Resend refused the message (HTTP ${response.status})` +
          `${body?.message === undefined ? '' : `: ${body.message}`}`,
      );
    }

    return { providerMessageId: body?.id ?? null };
  }
}
