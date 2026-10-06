import { Module } from '@nestjs/common';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { TenantToolRegistryService } from './tenant-tool-registry.service';

// Agent (AI-owned): tenant tool defs to JSON schema for L3 (A2). No dependency-rule constraints apply directly.
@Module({
  imports: [TenantContextModule],
  controllers: [],
  providers: [TenantToolRegistryService],
  exports: [TenantToolRegistryService],
})
export class ToolRegistryModule {}
