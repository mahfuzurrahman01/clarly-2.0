import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CoreModule } from '../core';
import { QueueModule } from '../queue/queue.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { OUTBOUND_WEBHOOK_QUEUE } from './outbound-webhook.queue';
import { OutboundWebhookProcessor } from './outbound-webhook.processor';
import { OutboundController } from './outbound.controller';
import { TenantWebhookService } from './tenant-webhook.service';
import { WebhookDeliveryService } from './webhook-delivery.service';

export * from './outbound-webhook.queue';
export { TenantWebhookService } from './tenant-webhook.service';

// Product shell: outbound webhooks (F11) — how structured data reaches a
// tenant's own system.
//
// WhatsappModule supplies the credential encryption service; the signing
// secret gets the same envelope as BSP credentials rather than a second
// keyed implementation to trust.
@Module({
  imports: [
    AuthModule,
    BillingModule,
    CoreModule,
    QueueModule,
    TenantContextModule,
    WhatsappModule,
    BullModule.registerQueue({
      name: OUTBOUND_WEBHOOK_QUEUE,
      defaultJobOptions: {
        // Bounded, with backoff: a tenant endpoint that is down for a minute
        // recovers on its own, and one that is down for a day should not have
        // us retrying forever.
        attempts: 4,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [OutboundController],
  providers: [
    TenantWebhookService,
    WebhookDeliveryService,
    OutboundWebhookProcessor,
  ],
  exports: [TenantWebhookService],
})
export class OutboundModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(OutboundController);
  }
}
