import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { CustomerConsentController } from './customer-consent.controller';
import { CustomerConsentService } from './customer-consent.service';
import { CustomerLabelController } from './customer-label.controller';
import { CustomerLabelService } from './customer-label.service';
import { CustomerMarketingConsentController } from './customer-marketing-consent.controller';
import { CustomerService } from './customer.service';

export * from './customer.dto';
export * from './consent-keyword';
export * from './customer-consent.dto';
export * from './customer-label.dto';
export * from './customer-label-derivation';
export { CustomerService } from './customer.service';
export { CustomerConsentService } from './customer-consent.service';
export { CustomerLabelService } from './customer-label.service';
export type { CustomerConsent } from './customer-consent.service';

// Product shell (Feature 5, T13): persistent customer profile — phone,
// name, tags, notes — shared across all conversations/tickets for that
// customer. No dependency-rule constraints apply directly.
//
// Also owns messaging consent (CustomerConsentService): a customer who says
// STOP must stop hearing from us, and `customers` is already exactly one row
// per (tenant, phone), which is the grain consent is expressed at.
//
// And, as of Feature 18, the customer's intent label (CustomerLabelService):
// the Hot/Warm/Cold value derived from A5's existing per-turn escalation
// decision, plus the human override that outranks it. Same grain argument
// again — one label per customer — which is why it lives here rather than in a
// module of its own.
@Module({
  imports: [TenantContextModule, AuthModule, AuditModule, BillingModule],
  controllers: [
    CustomerConsentController,
    CustomerLabelController,
    CustomerMarketingConsentController,
  ],
  providers: [CustomerService, CustomerConsentService, CustomerLabelService],
  exports: [CustomerService, CustomerConsentService, CustomerLabelService],
})
export class CustomerModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenantAuthMiddleware)
      .forRoutes(
        CustomerConsentController,
        CustomerLabelController,
        CustomerMarketingConsentController,
      );
  }
}
