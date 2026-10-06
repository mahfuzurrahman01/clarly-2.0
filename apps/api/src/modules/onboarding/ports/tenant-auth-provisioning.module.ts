import { Module } from '@nestjs/common';
import { AppConfigService, CoreModule } from '../../core';
import { NoopProvisioningAdapter } from './noop-provisioning.adapter';
import { SupabaseAdminProvisioningAdapter } from './supabase-admin-provisioning.adapter';
import { TenantAuthProvisioningPort } from './tenant-auth-provisioning.port';

export { TenantAuthProvisioningPort } from './tenant-auth-provisioning.port';

// A LEAF. It imports CoreModule and nothing else, and it must stay that way.
//
// WHY IT EXISTS
// -------------
// Nine modules need `TenantAuthProvisioningPort` — users live in Supabase
// auth rather than in this database, so this port is the only directory of
// people there is, and anything that resolves an actor email, mails a
// tenant's admins or revokes a member's claims has to reach it.
//
// Until now that meant importing the whole `OnboardingModule` for one
// provider. `OnboardingModule` sits near the TOP of the graph — it imports
// AgentConfigModule, BillingModule, CatalogModule, TicketModule — so every
// such import was an edge from a low-level module back up to the top. Each
// one on its own looked harmless ("safe direction: onboarding doesn't import
// anything that leads back here"), and each one was a latent cycle waiting
// for someone to add an unrelated edge further down.
//
// That is exactly what happened in `2cf5d85` (Phase 7 / F25). Adding
// `ToolExecutionModule -> OrderModule -> StoreModule` closed the ring
// `OnboardingModule -> AgentConfigModule -> AgentModule -> ToolExecutionModule
//  -> OrderModule -> StoreModule -> CustomerModule -> AuditModule ->
//  OnboardingModule`, and the API stopped booting entirely
// (`UndefinedModuleException`) while the build and all 3090 unit tests stayed
// green. The F25 commit did nothing wrong locally; the reach-back edge from
// `AuditModule` is what made a local change fatal at the other end of the graph.
//
// The binding below depends on nothing but `CoreModule`, so extracting it
// into a leaf removes the reach-back entirely: a consumer that needs only the
// port imports THIS module and can never acquire a path back to onboarding.
// `OnboardingModule` re-exports the port, so its own services and any
// consumer that legitimately also needs `TenantPolicyService` /
// `TenantProvisioningService` / `TeamInviteService` keep working unchanged.
//
// Adding an import to this module would undo all of that. Don't.
//
// The port and both adapters stay under `onboarding/ports/` — they are
// onboarding's contract, and the `@supabase/supabase-js` module-boundary
// exemption (see eslint.module-boundaries.mjs) is scoped to that directory.
// `apps/api/src/module-graph.spec.ts` now fails on any cycle without a
// `forwardRef`, so the next ring gets caught in CI rather than at boot.
@Module({
  imports: [CoreModule],
  providers: [
    SupabaseAdminProvisioningAdapter,
    NoopProvisioningAdapter,
    {
      provide: TenantAuthProvisioningPort,
      useFactory: (
        config: AppConfigService,
        supabase: SupabaseAdminProvisioningAdapter,
        noop: NoopProvisioningAdapter,
      ) => (config.tenantProvisioningProvider === 'supabase' ? supabase : noop),
      inject: [
        AppConfigService,
        SupabaseAdminProvisioningAdapter,
        NoopProvisioningAdapter,
      ],
    },
  ],
  exports: [TenantAuthProvisioningPort],
})
export class TenantAuthProvisioningModule {}
