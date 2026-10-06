import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CourierToolSeederService } from '../courier/courier-tool-seeder.service';
import { ToolRegistryModule } from '../tool-registry/tool-registry.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { TenantAuthProvisioningModule } from './ports/tenant-auth-provisioning.module';
import { SignupController } from './signup.controller';
import { TeamInviteController } from './team-invite.controller';
import { TeamInviteService } from './team-invite.service';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';
import { TicketModule } from '../ticket/ticket.module';
import { TenantPolicyController } from './tenant-policy.controller';
import { AgentConfigModule } from '../agent-config/agent-config.module';
import { TenantDirectoryService } from './tenant-directory.service';
import { TenantController } from './tenant.controller';
import { TenantPolicyService } from './tenant-policy.service';
import { TenantProvisioningService } from './tenant-provisioning.service';

export * from './tenant-directory.dto';
export * from './tenant-policy.dto';
export * from './tenant-provisioning.dto';
export * from './team-invite.dto';
export * from './team.dto';
export { TenantProvisioningService } from './tenant-provisioning.service';
export { TeamInviteService } from './team-invite.service';
export { TenantAuthProvisioningPort } from './ports/tenant-auth-provisioning.port';

// Product shell: tenant signup, KB upload, policy config. No dependency-rule constraints apply directly.
// Exempted from the `@supabase/supabase-js` half of the module-boundary
// rule 4 ban (see eslint.module-boundaries.mjs's own comment) — this is
// the one module that legitimately needs Supabase's Auth Admin API, not a
// raw DB connection.
//
// THIS PASS (Feature 2.5's T15 TenantPolicyService/TenantPolicyController
// pulled forward in Feature 5, plus Feature 6's tenant provisioning + team
// invite): `TenantProvisioningService.signUp()` creates a real `tenants`
// row and assigns the signing-up user as its first admin;
// `TeamInviteService.inviteMember()` lets that admin add more users into
// the SAME tenant with either role. Both go through the same
// `TenantAuthProvisioningPort`, whose runtime binding
// (`SupabaseAdminProvisioningAdapter` when
// `TENANT_PROVISIONING_PROVIDER=supabase`, else `NoopProvisioningAdapter`)
// now lives in the leaf `TenantAuthProvisioningModule`. KB upload UI
// (shipped, Slice 1) + WhatsApp connect (still blocked on T0) round out
// Feature 6.
//
// CYCLES: this module sits near the TOP of the graph — it imports
// AgentConfigModule, BillingModule, CatalogModule, TicketModule — so an edge
// INTO it from a lower-level module is how a ring gets closed. That is what
// happened in `2cf5d85` (F25) via AuditModule, and the API stopped booting.
// Modules that need only `TenantAuthProvisioningPort` must therefore import
// `TenantAuthProvisioningModule` (a leaf that imports only CoreModule), NOT
// this module. It is re-exported below purely so the consumers that DO need
// `TenantPolicyService`/`TenantProvisioningService`/`TeamInviteService` as
// well keep getting the port from one import. See that module's header for
// the full story; `src/module-graph.spec.ts` now fails CI on any cycle that
// is not deliberately broken with `forwardRef`.
@Module({
  imports: [
    // F9: the legacy policy PATCH writes through to the tenant's agent, so an
    // edit there still changes how the agent answers.
    AgentConfigModule,
    AuthModule,
    BillingModule,
    // F20: a new tenant gets the `lookup_product` agent tool enabled at
    // signup (CatalogToolSeederService) — a tool no path ever seeds is a
    // tool the agent can never call. CatalogModule imports
    // Auth/Billing/TenantContext/ToolRegistry, so this edge is acyclic —
    // though it is `src/module-graph.spec.ts`, not this comment, that keeps
    // it that way as the graph changes.
    CatalogModule,
    // F26 (D4): `track_order` is seeded at signup too. The SERVICE is
    // provided here rather than importing CourierModule, deliberately —
    // CourierModule sits well below this module and pulls in the whole
    // shipment/notification stack, so importing it here is a large edge to
    // take for one seeder. `CourierToolSeederService`
    // depends on nothing but the tool registry and the logger, so providing
    // it directly is the smaller, cycle-free seam.
    ToolRegistryModule,
    TenantContextModule,
    PersistenceModule,
    // The port's binding, extracted into a leaf so that the eight modules
    // that need only the port no longer have to import this one. Re-exported
    // below.
    TenantAuthProvisioningModule,
    // F15: removing a member releases the tickets they were holding.
    // Safe direction — TicketModule imports neither this module nor
    // KanbanModule, so no cycle.
    TicketModule,
  ],
  controllers: [
    TenantPolicyController,
    TenantController,
    SignupController,
    TeamInviteController,
    TeamController,
  ],
  providers: [
    CourierToolSeederService,
    TenantDirectoryService,
    TenantPolicyService,
    TenantProvisioningService,
    TeamInviteService,
    TeamService,
  ],
  exports: [
    TenantPolicyService,
    TenantProvisioningService,
    TeamInviteService,
    // Re-exported as the whole module (Nest cannot re-export a provider it
    // does not itself declare). KanbanModule imports this module for
    // TenantPolicyService AND reads the team directory through the port, so
    // re-exporting saves it a second import; a module that needs ONLY the
    // port must import TenantAuthProvisioningModule directly instead.
    TenantAuthProvisioningModule,
  ],
})
export class OnboardingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(
      TenantPolicyController,
      // Ungated by role, but still authenticated — the middleware is what
      // populates req.auth, so omitting it here would 401 every call.
      TenantController,
      TeamInviteController,
      TeamController,
    );
    // SignupController deliberately NOT here — it uses
    // FreshSignupAuthGuard (applied via its own @UseGuards()), never
    // TenantAuthMiddleware, since there's no tenant yet at signup time.
  }
}
