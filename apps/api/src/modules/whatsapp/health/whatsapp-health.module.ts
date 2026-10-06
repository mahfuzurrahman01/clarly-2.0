// Channel (Gulf T5 / D5): the daily WhatsApp number-health reconcile.
//
// A sibling of WhatsappModule (like ConnectModule) rather than part of it,
// so the many modules that import WhatsappModule for the send path do not
// each start a BullMQ worker. The pieces every writer shares (the
// connection-state policy, WhatsappNumberHealthStore and the WABA webhook
// handler) live in WhatsappModule; this module only owns the sweep.
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule } from '../../core';
import { MetaGraphModule } from '../../meta-graph/meta-graph.module';
import { QueueModule } from '../../queue/queue.module';
import { WhatsappModule } from '../whatsapp.module';
import { MetaPhoneNumberHealthReader } from './meta-phone-number-health.reader';
import { WHATSAPP_HEALTH_RECONCILE_QUEUE } from './whatsapp-health-reconcile.queue';
import { WhatsappHealthReconcileProcessor } from './whatsapp-health-reconcile.processor';
import { WhatsappHealthReconcileSchedulerService } from './whatsapp-health-reconcile-scheduler.service';
import { WhatsappHealthReconcileService } from './whatsapp-health-reconcile.service';

export { WhatsappHealthReconcileService } from './whatsapp-health-reconcile.service';

@Module({
  imports: [
    CoreModule,
    QueueModule,
    MetaGraphModule,
    WhatsappModule,
    BullModule.registerQueue({
      name: WHATSAPP_HEALTH_RECONCILE_QUEUE,
      defaultJobOptions: {
        // A missed sweep is recoverable (webhooks carry the urgent changes
        // and the next sweep is a day away), so retry modestly.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  providers: [
    MetaPhoneNumberHealthReader,
    WhatsappHealthReconcileService,
    WhatsappHealthReconcileProcessor,
    WhatsappHealthReconcileSchedulerService,
  ],
  exports: [WhatsappHealthReconcileService],
})
export class WhatsappHealthModule {}
