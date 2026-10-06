import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { TicketModule } from '../ticket/ticket.module';
import { KanbanController } from './kanban.controller';

// Product shell: console API + SSE (T7/T8).
//
// THIS PASS (Feature 5, T7/T8's HTTP+SSE half): the first real HTTP
// controller in the app. `TenantAuthMiddleware` (T7) is applied to every
// route on `KanbanController` via `configure()` below — every handler
// runs with `req.auth`/tenant context already resolved. No `@Roles()`
// gate on any kanban route this pass (see kanban.controller.ts's header
// comment for why); the T14 admin-vs-agent verify criterion lands with
// Feature 6's tenant-policy admin API, which is the surface that's
// actually admin-only per T14's own spec.
@Module({
  // OnboardingModule supplies TenantPolicyService, read by `GET
  // /kanban/tickets/config` for the stuck-ticket threshold. Same direction as
  // AlertingModule's existing dependency on it — policy is owned there.
  imports: [
    AuthModule,
    // Launch billing backend (Lane A): supplies EntitlementGuard, applied
    // to claim/assign/resolve below — reads (list/get/config/team/SSE
    // stream) stay ungated.
    BillingModule,
    OnboardingModule,
    TenantContextModule,
    TicketModule,
  ],
  controllers: [KanbanController],
  providers: [],
  exports: [],
})
export class KanbanModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(KanbanController);
  }
}
