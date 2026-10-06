// Channel (WhatsappModule, Gulf T5 / D5): applies the WABA health webhook
// fields (account_update, phone_number_quality_update,
// phone_number_name_update) to `whatsapp_numbers`.
//
// Called by WebhookController only AFTER WebhookIngestService has verified
// the X-Hub-Signature-256 of the same raw body; this service trusts that and
// does not re-verify. Every write is idempotent (a transition that already
// happened is a no-op, a tier/name write is a plain overwrite), so a Meta
// redelivery is harmless.
//
// A failing write does not stop the rest of the batch; the first failure is
// rethrown at the end so the webhook answers 500 and Meta redelivers.
import { Injectable } from '@nestjs/common';
import { AppConfigService, AppLoggerService } from '../../core';
import {
  parseWabaHealthWebhook,
  type WabaHealthEvent,
} from './waba-health-webhook.parser';
import { WhatsappNumberHealthStore } from './whatsapp-number-health.store';

const CONTEXT = 'WabaHealthWebhookService';

@Injectable()
export class WabaHealthWebhookService {
  constructor(
    private readonly store: WhatsappNumberHealthStore,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  async apply(rawBody: string | Buffer): Promise<void> {
    const events = parseWabaHealthWebhook(rawBody, {
      appId: this.config.metaAppId,
    });
    let firstFailure: Error | null = null;

    for (const event of events) {
      try {
        await this.applyOne(event);
      } catch (error) {
        firstFailure ??=
          error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `waba health webhook: ${event.kind} for waba ${event.wabaId} failed: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
          CONTEXT,
        );
      }
    }

    if (firstFailure !== null) throw firstFailure;
  }

  private async applyOne(event: WabaHealthEvent): Promise<void> {
    switch (event.kind) {
      case 'connection': {
        const affected = await this.store.transitionByWaba(
          event.wabaId,
          event.transition,
        );
        for (const number of affected) {
          this.logger.warn(
            `waba health webhook: ${event.event} moved number ${number.phoneNumberId} of tenant ${number.tenantId} to ${number.connectionState}`,
            CONTEXT,
          );
        }
        return;
      }
      case 'messaging_limit': {
        const updated = await this.store.setMessagingLimitForWaba(
          event.wabaId,
          event.tier,
        );
        this.logger.log(
          `waba health webhook: messaging limit ${event.tier} for waba ${event.wabaId} (${updated} number(s))`,
          CONTEXT,
        );
        return;
      }
      case 'name_status': {
        const updated = await this.store.setNameStatus(
          event.wabaId,
          event.displayPhoneNumber,
          event.nameStatus,
        );
        this.logger.log(
          `waba health webhook: display name ${event.nameStatus} for waba ${event.wabaId} (${updated} number(s))`,
          CONTEXT,
        );
        return;
      }
    }
  }
}
