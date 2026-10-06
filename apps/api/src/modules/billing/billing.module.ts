import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { AppConfigService } from '../core';
import { PersistenceModule } from '../persistence/persistence.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { BillingController } from './billing.controller';
import { BillingPublicController } from './billing-public.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingService } from './billing.service';
import { EntitlementGuard } from './entitlement.guard';
import { NoopBillingProvider } from './ports/noop-billing.provider';
import { BillingProvider } from './ports/billing-provider.port';
import { StripeBillingProvider } from './ports/stripe-billing.provider';
import { UsageService } from './usage.service';

export * from './billing.dto';
export * from './usage.dto';
export { BillingService } from './billing.service';
export { BillingProvider } from './ports/billing-provider.port';
export { UsageService } from './usage.service';
export { EntitlementGuard } from './entitlement.guard';

// Product shell (Feature 8, T19/T20): "Plan/subscription schema, payment
// provider integration (Stripe — confirmed 2026-08-13), plan-gating on
// tenant-scoped endpoints, trial/dunning flow" + "usage metering off the
// tokens/cost columns A8 already writes to agent_runs; ties into T17's
// spend-cap enforcement."
//
// THIS PASS: plan catalog (read-only, seed-only write), subscription
// lifecycle (checkout -> webhook -> status updates), bound to
// `StripeBillingProvider` (real) when `BILLING_PROVIDER=stripe`, else
// `NoopBillingProvider` (default). `UsageService` (T20) aggregates
// `agent_runs` for the current billing period AND is T17's actual
// spend-cap enforcement check — `RespondPathProcessor` (WebhookModule)
// calls `checkEntitlement()` before every `AgentRuntime.respond()` call.
@Module({
  imports: [AuthModule, TenantContextModule, PersistenceModule],
  controllers: [
    BillingController,
    BillingPublicController,
    BillingWebhookController,
  ],
  providers: [
    BillingService,
    UsageService,
    EntitlementGuard,
    StripeBillingProvider,
    NoopBillingProvider,
    {
      provide: BillingProvider,
      useFactory: (
        config: AppConfigService,
        stripe: StripeBillingProvider,
        noop: NoopBillingProvider,
      ) => (config.billingProvider === 'stripe' ? stripe : noop),
      inject: [AppConfigService, StripeBillingProvider, NoopBillingProvider],
    },
  ],
  exports: [BillingService, UsageService, EntitlementGuard],
})
export class BillingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(BillingController);
    // BillingWebhookController deliberately NOT here — Stripe calls it
    // directly with no tenant JWT; trust comes from the webhook
    // signature instead (see that controller's own header comment).
  }
}
