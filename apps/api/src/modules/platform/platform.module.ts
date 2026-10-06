// Clarly 2.0 (docs/v2/ARCHITECTURE.md §4): the operator console's backend.
// Ported from Autologic's `/admin`, rebuilt on Clarly's isolation model:
// operator identity is `platform_admins`, never a tenant role, and per-tenant
// data is read through each tenant's own RLS scope.
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoreModule } from '../core';
import { PersistenceModule } from '../persistence/persistence.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformTenantsService } from './platform-tenants.service';
import { PlatformController } from './platform.controller';

export * from './platform-auth';
export * from './platform.dto';
export { PlatformAdminService } from './platform-admin.service';
export { PlatformAdminGuard } from './platform-admin.guard';
export { PlatformRoles } from './platform-roles.decorator';
export { CurrentPlatformAuth } from './current-platform-auth.decorator';

@Module({
  imports: [CoreModule, PersistenceModule, TenantContextModule, AuthModule],
  controllers: [PlatformController],
  providers: [PlatformAdminService, PlatformAdminGuard, PlatformTenantsService],
  exports: [PlatformAdminService, PlatformAdminGuard],
})
export class PlatformModule {}
