// F11: signing and sending one event to one tenant endpoint.
//
// Three properties this has to hold, none of them optional:
//   - the receiver can PROVE it came from us (HMAC over the exact bytes sent);
//   - a replayed body is detectable (the timestamp is signed with it);
//   - our request cannot be turned into a request to our own network
//     (SSRF check at delivery, not only at registration).
import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import { assertSafeWebhookUrl } from './webhook-url';

/** A tenant endpoint that is slow is a tenant endpoint we stop waiting on: a queue worker blocked on someone else's server delivers nothing else. */
const TIMEOUT_MS = 10_000;

export interface WebhookDeliveryResult {
  delivered: boolean;
  status?: number;
  error?: string;
  /** Whether trying again could plausibly work — a 400 will never succeed, a 503 might. */
  retryable: boolean;
}

@Injectable()
export class WebhookDeliveryService {
  constructor(private readonly logger: AppLoggerService) {}

  async deliver(input: {
    url: string;
    secret: string;
    event: string;
    body: Record<string, unknown>;
  }): Promise<WebhookDeliveryResult> {
    try {
      await assertSafeWebhookUrl(input.url);
    } catch (error) {
      // Never retryable: a URL pointing inside our network will still point
      // there in thirty seconds, and retrying is just more SSRF attempts.
      return {
        delivered: false,
        retryable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = JSON.stringify(input.body);
    // Timestamp inside the signed material: signing the body alone lets a
    // captured request be replayed forever, and the receiver has no way to
    // tell.
    const signature = createHmac('sha256', input.secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(input.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Event': input.event,
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Signature': `sha256=${signature}`,
        },
        body: payload,
        signal: controller.signal,
        // No redirects: a 302 is how a validated destination becomes an
        // unvalidated one after the SSRF check has already passed.
        redirect: 'manual',
      });

      if (response.status >= 200 && response.status < 300) {
        return { delivered: true, status: response.status, retryable: false };
      }

      return {
        delivered: false,
        status: response.status,
        // 4xx means they rejected it and always will; 5xx and 429 are worth
        // another attempt.
        retryable: response.status >= 500 || response.status === 429,
        error: `endpoint responded ${response.status}`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `webhook delivery to ${input.url} failed: ${detail}`,
        'WebhookDeliveryService',
      );
      // Network-level failures (timeout, DNS, connection refused) are the
      // ones a retry exists for.
      return { delivered: false, retryable: true, error: detail };
    } finally {
      clearTimeout(timer);
    }
  }
}
