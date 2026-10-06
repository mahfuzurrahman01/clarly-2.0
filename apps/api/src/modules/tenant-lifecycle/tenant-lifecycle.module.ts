import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CoreModule } from '../core';
import { TenantAuthProvisioningModule } from '../onboarding/ports/tenant-auth-provisioning.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { StorageModule } from '../storage/storage.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { TenantLifecycleController } from './tenant-lifecycle.controller';
import { TenantLifecycleService } from './tenant-lifecycle.service';
import { TenantPurgeProcessor } from './tenant-purge.processor';
import { TENANT_PURGE_QUEUE } from './tenant-purge.queue';
import { TenantPurgeSchedulerService } from './tenant-purge-scheduler.service';

export * from './tenant-lifecycle.dto';
export { TenantLifecycleService } from './tenant-lifecycle.service';

// T16's remaining slice: full tenant offboarding, with a grace period.
//
// Its own module rather than more code in OnboardingModule or RetentionModule,
// because erasing a tenant needs to reach almost everything — billing (cancel
// the subscription), storage (delete the files), retrieval (drop the vector
// partition), and onboarding (revoke every member's claims). Putting that
// dependency set inside any of those modules would make them mutually
// dependent. Nothing imports this module, so the fan-in stays one-directional
// and no cycle is possible.
//
// Onboarding is reached through the leaf TenantAuthProvisioningModule, not
// OnboardingModule: revoking claims needs only TenantAuthProvisioningPort, and
// importing the whole of onboarding for one port is the shape that closed the
// F25 ring and stopped the API booting.
//
// The one piece deliberately NOT here is the closed-tenant access check:
// TenantStatusService lives in TenantContextModule, because
// TenantAuthMiddleware is what enforces it and AuthModule cannot import this.
@Module({
  imports: [
    CoreModule,
    AuthModule,
    PersistenceModule,
    TenantContextModule,
    QueueModule,
    StorageModule,
    RetrievalModule,
    BillingModule,
    TenantAuthProvisioningModule,
    // Closing and reopening are exactly the actions a security review asks
    // about, so they carry an audit description.
    AuditModule,
    BullModule.registerQueue({
      name: TENANT_PURGE_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [TenantLifecycleController],
  providers: [
    TenantLifecycleService,
    TenantPurgeProcessor,
    TenantPurgeSchedulerService,
  ],
  exports: [TenantLifecycleService],
})
export class TenantLifecycleModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(TenantLifecycleController);
  }
}
