// DunningEmailService: sends payment-failure reminder emails to tenants with
// past_due subscriptions. Same sweep pattern as TrialEmailService — enumerate
// all tenants via admin query, check each subscription status, email once per
// dunning window using NotificationService deduplication.
//
// Stripe fires invoice.payment_failed → subscription becomes past_due. This
// sweep catches tenants who have not resolved the failure and reminds them to
// update their payment method via the Stripe billing portal.
import { Injectable } from '@nestjs/common';
import { tenants } from '../persistence/drizzle/schema';
import { AppConfigService, AppLoggerService } from '../core';
import { PersistenceService } from '../persistence/persistence.service';
import { BillingService } from '../billing/billing.service';
import { EmailSender } from '../email/ports/email-sender.port';
import { NotificationService } from '../notifications/notification.service';
import {
  notificationContent,
  type NotificationContent,
} from '../notifications/notification-content';
import { TenantAuthProvisioningPort } from '../onboarding/ports/tenant-auth-provisioning.port';

export interface DunningEmailSweepResult {
  dunningEmailed: number;
}

@Injectable()
export class DunningEmailService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly billing: BillingService,
    private readonly notifications: NotificationService,
    private readonly email: EmailSender,
    private readonly provisioning: TenantAuthProvisioningPort,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  async sweep(): Promise<DunningEmailSweepResult> {
    const tenantRows = await this.persistence.runAdminQuery((db) =>
      db.select({ id: tenants.id }).from(tenants),
    );

    let dunningEmailed = 0;

    for (const tenant of tenantRows) {
      const emailed = await this.checkTenant(tenant.id);
      if (emailed) dunningEmailed += 1;
    }

    return { dunningEmailed };
  }

  private async checkTenant(tenantId: string): Promise<boolean> {
    const subscription = await this.billing.getForTenant(tenantId);
    if (
      !subscription ||
      subscription.comped ||
      subscription.status !== 'past_due'
    ) {
      return false;
    }

    const notified = await this.notify(
      tenantId,
      `payment-failed-${subscription.id}`,
      notificationContent.paymentFailed(),
    );
    return notified;
  }

  private async notify(
    tenantId: string,
    dedupKey: string,
    content: NotificationContent,
  ): Promise<boolean> {
    const { title, body } = content;
    const isNew = await this.notifications.record({
      tenantId,
      ...content,
      severity: 'critical',
      dedupKey,
    });
    if (!isNew) return false;

    if (!this.email.isEnabled()) {
      this.logger.debug(
        `no mail provider configured — "${title}" for tenant ${tenantId} was recorded but not emailed`,
        'DunningEmailService',
      );
      return true;
    }

    try {
      const members = await this.provisioning.listTeamMembers(tenantId);
      const recipients = members
        .filter((member) => member.appRole === 'admin' && member.email !== '')
        .map((member) => member.email);
      if (recipients.length === 0) {
        this.logger.warn(
          `tenant ${tenantId} has no admin with an email address — "${title}" was recorded but could not be emailed`,
          'DunningEmailService',
        );
        return true;
      }

      await this.email.send({
        to: recipients,
        subject: title,
        text: `${body}\n`,
      });
      this.logger.log(
        `emailed "${title}" to ${recipients.length} admin(s) of tenant ${tenantId}`,
        'DunningEmailService',
      );
    } catch (error) {
      this.logger.error(
        `failed to email "${title}" to tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'DunningEmailService',
      );
    }
    return true;
  }
}
