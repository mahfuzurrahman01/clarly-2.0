import { Module } from '@nestjs/common';
import { CoreModule } from '../core';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { FreshSignupAuthGuard } from './fresh-signup-auth.guard';
import { RolesGuard } from './roles.guard';
import { SupabaseJwtService } from './supabase-jwt.service';
import { TenantAuthMiddleware } from './tenant-auth.middleware';

export * from './jwt-claims';
export * from './roles.decorator';
export * from './current-auth.decorator';
export * from './current-fresh-signup-auth.decorator';
export { RolesGuard } from './roles.guard';
export { SupabaseJwtService } from './supabase-jwt.service';
export { TenantAuthMiddleware } from './tenant-auth.middleware';
export { FreshSignupAuthGuard } from './fresh-signup-auth.guard';

// Product shell: tenant + human-agent auth, JWT tenant claim feeds
// TenantContext (T7), admin/agent role distinction (T14), fresh-signup
// auth boundary (Feature 6). No dependency-rule constraints apply
// directly. Exports TenantAuthMiddleware for Feature 2+ controllers to
// apply via `consumer.apply(TenantAuthMiddleware).forRoutes(...)` — see
// tenant-auth.middleware.ts for why this is middleware, not a Guard.
// Exports RolesGuard for controllers to apply per-route via
// `@UseGuards(RolesGuard)` + `@Roles(...)` — see roles.guard.ts for why
// this one IS a Guard. Exports FreshSignupAuthGuard for
// `SignupController` only — every other route keeps using
// TenantAuthMiddleware, never this.
@Module({
  imports: [CoreModule, TenantContextModule],
  controllers: [],
  providers: [
    SupabaseJwtService,
    TenantAuthMiddleware,
    RolesGuard,
    FreshSignupAuthGuard,
  ],
  exports: [
    SupabaseJwtService,
    TenantAuthMiddleware,
    RolesGuard,
    FreshSignupAuthGuard,
  ],
})
export class AuthModule {}
