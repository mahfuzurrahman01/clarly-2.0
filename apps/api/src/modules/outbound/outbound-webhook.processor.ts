// F11: the worker that actually posts to a tenant's endpoint.
//
// Off the respond path on purpose: a tenant's slow or dead endpoint must not
// add latency to a customer's reply, and must not be able to fail one.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import {
  OUTBOUND_WEBHOOK_QUEUE,
  type OutboundWebhookJobData,
} from './outbound-webhook.queue';
import { TenantWebhookService } from './tenant-webhook.service';
import { WebhookDeliveryService } from './webhook-delivery.service';

/** Thrown to make BullMQ retry. A non-retryable failure returns normally instead, so the queue does not burn attempts on something that cannot succeed. */
class RetryableDeliveryError extends Error {}

@Processor(OUTBOUND_WEBHOOK_QUEUE)
export class OutboundWebhookProcessor extends WorkerHost {
  constructor(
    private readonly webhooks: TenantWebhookService,
    private readonly delivery: WebhookDeliveryService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(job: Job<OutboundWebhookJobData>): Promise<void> {
    const { tenantId, webhookId, event, body } = job.data;

    const target = await this.webhooks.getForDelivery(tenantId, webhookId);
    if (!target) {
      // Deleted or disabled between queueing and delivery. Not an error: a
      // tenant turning an endpoint off should stop deliveries, not produce
      // failures they then have to investigate.
      return;
    }

    const result = await this.delivery.deliver({
      url: target.url,
      secret: target.secret,
      event,
      body,
    });

    await this.webhooks.recordOutcome(tenantId, webhookId, {
      ok: result.delivered,
      error: result.error,
    });

    if (result.delivered) return;

    if (result.retryable) {
      throw new RetryableDeliveryError(result.error ?? 'delivery failed');
    }

    // Permanent: a 400 or an unsafe URL will fail identically on every
    // attempt, so it is recorded and dropped rather than retried three times
    // to reach the same answer.
    this.logger.warn(
      `webhook ${webhookId} (tenant ${tenantId}) permanently rejected ${event}: ${result.error ?? 'unknown'}`,
      'OutboundWebhookProcessor',
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<OutboundWebhookJobData> | undefined, error: Error): void {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;

    // Exhausted. The outcome is already on the webhook row, so a tenant can
    // see their endpoint is broken without anyone reading this log line.
    this.logger.error(
      `webhook ${job.data.webhookId} gave up on ${job.data.event} after ${attempts} attempts: ${error.message}`,
      'OutboundWebhookProcessor',
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `outbound-webhook worker connection error: ${error.message}`,
      error.stack,
      'OutboundWebhookProcessor',
    );
  }
}
