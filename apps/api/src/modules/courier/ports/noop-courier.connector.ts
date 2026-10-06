// F26 (Delivery Tracking): the fail-closed adapter the registry returns for a
// courier name it does not know (D2).
//
// It is a real adapter, not a placeholder credential: it refuses credentials,
// returns no tracking results, and refuses every signature. An unknown
// courier must never resolve to something that pretends a call worked — that
// is how a shipment would sit at `label_created` forever while the console
// showed a healthy connection.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../../core';
import {
  CourierAuthenticationError,
  CourierConnector,
  type CourierTrackingResult,
} from './courier-connector.port';

@Injectable()
export class NoopCourierConnector extends CourierConnector {
  /** Never matched by the registry — the registry keys on the four real names and falls back here. */
  readonly courier = 'aramex' as const;

  /** null keeps the webhook route's step-1 rejection applying to unknown couriers too. */
  readonly webhookSignatureHeader = null;

  constructor(private readonly logger: AppLoggerService) {
    super();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async verifyCredentials(): Promise<void> {
    this.logger.error(
      'NoopCourierConnector: credential verification requested for an unsupported courier — refusing.',
      'NoopCourierConnector',
    );
    throw new CourierAuthenticationError(
      'aramex',
      'this courier is not supported by this deployment',
    );
  }

  /**
   * Read-shaped refusal, not a throw. A poll sweep that threw here would mark
   * the whole batch failed and back off; returning no results leaves the
   * shipment exactly as it was, which is the honest outcome — we learned
   * nothing about it.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async track(): Promise<CourierTrackingResult[]> {
    this.logger.warn(
      'NoopCourierConnector: tracking requested for an unsupported courier — returning no results.',
      'NoopCourierConnector',
    );
    return [];
  }

  verifyWebhookSignature(): boolean {
    this.logger.warn(
      'NoopCourierConnector: webhook signature check for an unsupported courier — refusing.',
      'NoopCourierConnector',
    );
    return false;
  }

  extractEventId(): string | null {
    return null;
  }

  normalizeWebhookEvent(): null {
    return null;
  }
}
