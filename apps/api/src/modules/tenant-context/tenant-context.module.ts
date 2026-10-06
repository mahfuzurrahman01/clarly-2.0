import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { TenantContextService } from './tenant-context.service';
import { TenantDirectoryService } from './tenant-directory';
import { TenantStatusService } from './tenant-status.service';

// Platform: AsyncLocalStorage tenant ctx + withTenantTx() setting the RLS
// GUC; every tenant-scoped DB touch goes through it (T5/T7). Enforced rule
// 4: only PersistenceModule/TenantContextModule may open a raw DB
// connection — this module is the other permitted PersistenceModule
// importer; every other module must depend on TenantContextService instead.
@Module({
  imports: [PersistenceModule],
  controllers: [],
  providers: [
    TenantContextService,
    TenantStatusService,
    TenantDirectoryService,
  ],
  exports: [TenantContextService, TenantStatusService, TenantDirectoryService],
})
export class TenantContextModule {}
