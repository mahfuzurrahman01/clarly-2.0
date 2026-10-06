import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CoreModule } from '../core';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { DataExportAssemblerService } from './data-export-assembler.service';
import { DataExportController } from './data-export.controller';
import { DataExportExpirySchedulerService } from './data-export-expiry-scheduler.service';
import { DataExportProcessor } from './data-export.processor';
import { DATA_EXPORT_QUEUE } from './data-export.queue';
import { DataExportService } from './data-export.service';

export * from './data-export.dto';
export { DataExportService } from './data-export.service';

// A tenant's right to a copy of their own data (GDPR Article 15), and the
// other half of the exit story next to tenant offboarding — leaving is not
// much use if you cannot take anything with you.
//
// Depends on nothing feature-shaped: the assembler reads tables directly
// through TenantContextService rather than calling each owning module's
// service. That is deliberate. Going through services would mean this module
// importing almost every other one, and it would export whatever those
// services choose to expose rather than what the tenant actually owns — an
// export must be complete, not curated.
@Module({
  imports: [
    CoreModule,
    AuthModule,
    BillingModule,
    PersistenceModule,
    TenantContextModule,
    QueueModule,
    StorageModule,
    AuditModule,
    BullModule.registerQueue({
      name: DATA_EXPORT_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [DataExportController],
  providers: [
    DataExportService,
    DataExportAssemblerService,
    DataExportProcessor,
    DataExportExpirySchedulerService,
  ],
  exports: [DataExportService],
})
export class DataExportModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(DataExportController);
  }
}
