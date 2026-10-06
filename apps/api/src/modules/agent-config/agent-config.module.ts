import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CoreModule } from '../core';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { AgentModule } from '../agent/agent.module';
import { AgentConfigService } from './agent-config.service';
import { AgentSandboxService } from './agent-sandbox.service';
import { AgentManagementService } from './agent-management.service';
import { AgentsController } from './agents.controller';

export * from './agent-config.dto';
export * from './agent-config.dto.zod';
export { AgentConfigService } from './agent-config.service';
export { AgentManagementService } from './agent-management.service';

// Product shell: which agent owns a turn, and (from F9 step 3) how it is
// configured. Owns no HTTP surface — the console API for managing agents
// lands with the configuration write path.
@Module({
  // AgentModule supplies AgentRuntime for the sandbox — a real turn, minus
  // delivery and minus any recording.
  imports: [
    AgentModule,
    AuthModule,
    BillingModule,
    CoreModule,
    TenantContextModule,
  ],
  controllers: [AgentsController],
  providers: [AgentConfigService, AgentManagementService, AgentSandboxService],
  exports: [AgentConfigService, AgentManagementService],
})
export class AgentConfigModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(AgentsController);
  }
}
