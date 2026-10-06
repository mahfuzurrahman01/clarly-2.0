import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { TenantAuthProvisioningModule } from '../onboarding/ports/tenant-auth-provisioning.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';

export * from './audit-detail';
export * from './audit-log.dto';
export { AuditLogService } from './audit-log.service';

// Platform: who did what, for a security review and for the tenant's own
// "who deleted that?" question.
//
// AuditInterceptor is registered as APP_INTERCEPTOR — GLOBAL, on purpose and
// worth understanding before changing it. A per-controller `@UseInterceptors()`
// would audit exactly the controllers someone remembered to decorate, which is
// the failure mode that makes an audit log worthless: it looks complete and
// quietly is not. Global registration inverts that. A new admin endpoint is
// audited by default, and opting out would take a deliberate act.
//
// The interceptor filters to authenticated, state-changing requests, so the
// BSP webhook firehose and the console's polling reads do not land in it.
//
// Imports TenantAuthProvisioningModule for TenantAuthProvisioningPort — actor
// emails are resolved at read time rather than stored, so an entry never goes
// stale against a renamed account.
//
// It used to import the whole OnboardingModule for that one port, on the claim
// that "OnboardingModule imports neither this module nor anything that leads
// back here". That claim stopped being true in `2cf5d85` (Phase 7 / F25),
// which added `ToolExecutionModule -> OrderModule -> StoreModule` and thereby
// closed `OnboardingModule -> AgentConfigModule -> AgentModule ->
// ToolExecutionModule -> OrderModule -> StoreModule -> CustomerModule ->
// AuditModule -> OnboardingModule`. No forwardRef anywhere on that ring, so
// the API stopped booting with UndefinedModuleException while the build and
// every unit test stayed green.
//
// The lesson is not "re-check the claim"; a claim about the whole graph
// cannot be maintained from one module's file. TenantAuthProvisioningModule is
// a leaf that imports only CoreModule, so this edge cannot participate in a
// cycle no matter what anyone adds elsewhere. Do not import OnboardingModule
// here again.
@Module({
  imports: [
    AuthModule,
    TenantContextModule,
    PersistenceModule,
    TenantAuthProvisioningModule,
  ],
  controllers: [AuditLogController],
  providers: [
    AuditLogService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditLogService],
})
export class AuditModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(AuditLogController);
  }
}
