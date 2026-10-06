// Product shell (BillingLifecycleModule, Lane A item 10): trial-ending
// (T-minus-N-days) and trial-expired emails, off UsageService's own
// `evaluateEntitlementGate()` decision table — a tenant is only ever
// emailed about a trial state this app would actually enforce, never a
// second, drifting copy of that logic.
//
// Same "list every tenant, per-tenant RLS-scoped check" shape as
// StuckTicketCheckService/LatencyBudgetCheckService (AlertingModule): a
// platform sweep needs `tenants` (not RLS-scoped) to enumerate ids, then
// `BillingService.getForTenant()` per tenant (tenant_subscriptions IS
// FORCE ROW LEVEL SECURITY — an admin-scoped bulk query across it would
// silently return zero rows, same trap billing.service.ts's own
// handleWebhookEvent() comment documents for stripe_customer_tenant_map).
//
// Idempotency: NotificationService.record()'s `ON CONFLICT DO NOTHING` on
// (tenantId, dedupKey) IS the idempotency mechanism — a sweep that reruns
// (the next scheduled tick, a retried BullMQ job) re-evaluates every
// tenant every time, but only ever WRITES (and therefore only ever
// EMAILS) once per tenant per trial. `record()` returning false means
// "already notified" and the email is skipped, not just the notification
// row.
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

export interface TrialEmailSweepResult {
  trialEndingEmailed: number;
  trialExpiredEmailed: number;
}

@Injectable()
export class TrialEmailService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly billing: BillingService,
    private readonly notifications: NotificationService,
    private readonly email: EmailSender,
    private readonly provisioning: TenantAuthProvisioningPort,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  async sweep(): Promise<TrialEmailSweepResult> {
    const tenantRows = await this.persistence.runAdminQuery((db) =>
      db.select({ id: tenants.id }).from(tenants),
    );

    let trialEndingEmailed = 0;
    let trialExpiredEmailed = 0;

    for (const tenant of tenantRows) {
      const outcome = await this.checkTenant(tenant.id);
      if (outcome === 'trial_ending') trialEndingEmailed += 1;
      if (outcome === 'trial_expired') trialExpiredEmailed += 1;
    }

    return { trialEndingEmailed, trialExpiredEmailed };
  }

  private async checkTenant(
    tenantId: string,
  ): Promise<'trial_ending' | 'trial_expired' | null> {
    const subscription = await this.billing.getForTenant(tenantId);
    // Comped or non-trialing tenants have nothing for this sweep to say —
    // same "not this sweep's problem" posture StuckTicketCheckService
    // takes toward a tenant with no open tickets.
    if (
      !subscription ||
      subscription.comped ||
      subscription.status !== 'trialing' ||
      !subscription.trialEndsAt
    ) {
      return null;
    }

    const now = Date.now();
    const trialEndsAtMs = subscription.trialEndsAt.getTime();
    const daysUntilEnd = (trialEndsAtMs - now) / (24 * 60 * 60 * 1000);

    if (trialEndsAtMs <= now) {
      const notified = await this.notify(
        tenantId,
        `trial-expired-${subscription.id}`,
        notificationContent.trialExpired(),
      );
      return notified ? 'trial_expired' : null;
    }

    if (daysUntilEnd <= this.config.trialEndingSoonDays) {
      const daysLeft = Math.max(1, Math.ceil(daysUntilEnd));
      const notified = await this.notify(
        tenantId,
        `trial-ending-${subscription.id}`,
        notificationContent.trialEnding({ daysLeft }),
      );
      return notified ? 'trial_ending' : null;
    }

    return null;
  }

  /**
   * Records the durable notification (idempotent — see header comment),
   * and mails it only when the notification was genuinely NEW. Never
   * throws: one tenant's mail failure (or having no admin email on file)
   * must not abort the sweep for every tenant after it in the loop, same
   * "returns whether it actually sent, logs and swallows on failure"
   * posture as AlertEmailService.sendCriticalAlert().
   */
  private async notify(
    tenantId: string,
    dedupKey: string,
    content: NotificationContent,
  ): Promise<boolean> {
    const { title, body } = content;
    const isNew = await this.notifications.record({
      tenantId,
      ...content,
      severity: 'warning',
      dedupKey,
    });
    if (!isNew) return false;

    if (!this.email.isEnabled()) {
      this.logger.debug(
        `no mail provider configured — "${title}" for tenant ${tenantId} was recorded but not emailed`,
        'TrialEmailService',
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
          'TrialEmailService',
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
        'TrialEmailService',
      );
    } catch (error) {
      this.logger.error(
        `failed to email "${title}" to tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'TrialEmailService',
      );
    }
    return true;
  }
}
