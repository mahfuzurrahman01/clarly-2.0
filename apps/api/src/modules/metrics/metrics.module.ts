import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { MetricsController } from './metrics.controller';
import { KnowledgeGapService } from './knowledge-gap.service';
import { MetricsService } from './metrics.service';

export * from './metrics.dto';
export { MetricsService } from './metrics.service';

// Product shell: resolution-rate + escalation-breakdown API (A9, Feature 5
// scope only — see metrics.service.ts's header comment on why the
// permanent `conversation_outcomes` table is Feature 7 work, not this
// pass). `agent_runs` -> `conversation_outcomes` rollup is out of scope
// (A8 remains deferred).
//
// `@Roles('admin')` on every route here (via `MetricsController`) is this
// codebase's first real exercise of T14's admin-vs-agent gate end to end.
@Module({
  imports: [AuthModule, BillingModule, TenantContextModule],
  controllers: [MetricsController],
  providers: [MetricsService, KnowledgeGapService],
  exports: [MetricsService, KnowledgeGapService],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(MetricsController);
  }
}
