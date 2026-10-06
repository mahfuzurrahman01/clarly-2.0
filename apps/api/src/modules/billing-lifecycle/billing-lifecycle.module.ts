import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule } from '../core';
import { BillingModule } from '../billing/billing.module';
import { EmailModule } from '../email/email.module';
import { NotificationRecordModule } from '../notifications/notification-record.module';
import { TenantAuthProvisioningModule } from '../onboarding/ports/tenant-auth-provisioning.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { TrialEmailCheckProcessor } from './trial-email.processor';
import { TRIAL_EMAIL_CHECK_QUEUE } from './trial-email.queue';
import { TrialEmailCheckSchedulerService } from './trial-email-scheduler.service';
import { TrialEmailService } from './trial-email.service';
import { DunningEmailCheckProcessor } from './dunning-email.processor';
import { DUNNING_EMAIL_CHECK_QUEUE } from './dunning-email.queue';
import { DunningEmailCheckSchedulerService } from './dunning-email-scheduler.service';
import { DunningEmailService } from './dunning-email.service';

export { TrialEmailService } from './trial-email.service';
export { DunningEmailService } from './dunning-email.service';

// Product shell (Launch billing backend, Lane A item 10): a scheduled
// BullMQ sweep over a trial's post-signup lifecycle — trial-ending /
// trial-expired email (TrialEmailService).
// Kept as a SEPARATE module from BillingModule rather than added to it,
// specifically to avoid a circular import: this module needs
// NotificationsModule (to record the durable notification), and
// NotificationsModule already imports BillingModule (for
// EntitlementGuard) — BillingModule importing NotificationsModule back
// would cycle. This module can safely depend on both.
//
// The lapsed-trial channel-deprovision sweep (Lane A item 11) was removed
// with 360dialog (D14, Gulf T2): it existed only to stop paying a
// per-number BSP fee for tenants who never paid. A Meta Cloud API number
// costs us nothing to keep connected, and a lapsed tenant's AI replies are
// already stopped by the respond-path entitlement gate.
@Module({
  imports: [
    BillingModule,
    CoreModule,
    EmailModule,
    NotificationRecordModule,
    PersistenceModule,
    // Trial/dunning mail needs the tenant admins' addresses, which live in
    // Supabase auth behind TenantAuthProvisioningPort. The leaf module, not
    // OnboardingModule — importing the whole of onboarding for one port is
    // what closed the F25 ring and stopped the API booting.
    TenantAuthProvisioningModule,
    BullModule.registerQueue({
      name: TRIAL_EMAIL_CHECK_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
    BullModule.registerQueue({
      name: DUNNING_EMAIL_CHECK_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  providers: [
    TrialEmailService,
    TrialEmailCheckProcessor,
    TrialEmailCheckSchedulerService,
    DunningEmailService,
    DunningEmailCheckProcessor,
    DunningEmailCheckSchedulerService,
  ],
  exports: [TrialEmailService, DunningEmailService],
})
export class BillingLifecycleModule {}
