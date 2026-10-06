import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AlertingModule } from '../alerting/alerting.module';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CoreModule } from '../core';
import { EmailModule } from '../email/email.module';
import { TenantAuthProvisioningModule } from '../onboarding/ports/tenant-auth-provisioning.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { AlertEmailService } from './alert-email.service';
import { AlertNotificationSubscriber } from './alert-notification.subscriber';
import { NotificationRecordModule } from './notification-record.module';
import { NotificationsController } from './notifications.controller';

export * from './notification.dto';
export { NotificationService } from './notification.service';

// Product shell: durable alerts a tenant can see (T4/T18).
//
// Depends on AlertingModule rather than the other way round: alerting owns
// detecting conditions and knows nothing about how they are delivered, which
// is what let the delivery channel stay unbuilt this long without the
// detectors rotting.
//
// That makes this module HIGH in the graph, so a low-level module importing
// it merely to record a notification is a reach-back that closed a ring in
// F25 and stopped the API booting. `NotificationService` therefore lives in
// the near-leaf NotificationRecordModule (see its header) and is re-exported
// from here; write-only consumers must import that module, not this one.
@Module({
  imports: [
    AlertingModule,
    AuthModule,
    // Launch billing backend (Lane A): supplies EntitlementGuard, applied
    // to the two write routes (mark read / mark all read) below.
    BillingModule,
    CoreModule,
    // Gap #3: a critical alert is also mailed to the tenant's admins, so this
    // module needs a sender and a way to find out who those admins are.
    // Users live in Supabase auth rather than in this database, so
    // TenantAuthProvisioningPort is the only directory there is. Imported
    // from its leaf module rather than from OnboardingModule — see that
    // module's header for why reaching back into onboarding for one port is
    // what broke the boot in F25.
    EmailModule,
    NotificationRecordModule,
    TenantAuthProvisioningModule,
    TenantContextModule,
  ],
  controllers: [NotificationsController],
  providers: [AlertEmailService, AlertNotificationSubscriber],
  // Re-exported as the whole module (Nest cannot re-export a provider it does
  // not itself declare) — see NotificationRecordModule.
  exports: [NotificationRecordModule],
})
export class NotificationsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(NotificationsController);
  }
}
