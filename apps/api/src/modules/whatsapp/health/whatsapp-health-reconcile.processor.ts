// Channel (WhatsappHealthModule, Gulf T5 / D5): the reconcile sweep worker.
// Per-number failures are already absorbed and counted by
// WhatsappHealthReconcileService, so a job only fails when the sweep itself
// cannot start (e.g. the database is down), and BullMQ's retry is right then.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { AppLoggerService } from '../../core';
import { WHATSAPP_HEALTH_RECONCILE_QUEUE } from './whatsapp-health-reconcile.queue';
import { WhatsappHealthReconcileService } from './whatsapp-health-reconcile.service';

@Processor(WHATSAPP_HEALTH_RECONCILE_QUEUE)
export class WhatsappHealthReconcileProcessor extends WorkerHost {
  constructor(
    private readonly reconcile: WhatsappHealthReconcileService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const summary = await this.reconcile.reconcileAll();
    this.logger.log(
      `whatsapp health reconcile: ${summary.checked} checked, ${summary.restricted} restricted, ${summary.reconnectRequired} needing reconnect, ${summary.failed} failed`,
      WhatsappHealthReconcileProcessor.name,
    );
  }

  // @nestjs/bullmq attaches no default 'error' listener; without one a Redis
  // blip on this worker's connection crashes the process.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `whatsapp-health-reconcile worker connection error: ${error.message}`,
      error.stack,
      WhatsappHealthReconcileProcessor.name,
    );
  }
}
