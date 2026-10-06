// OnboardingModule (Feature 6): "Tenant provisioning: tenant record
// creation + Supabase Auth custom-claim assignment (feeds TenantContext,
// T7)." Writes the tenants row via PersistenceService.runAdminQuery() —
// the same sanctioned escape hatch AlertingModule's cross-tenant sweep
// uses, justified here by tenants.table.ts's own header comment ("written
// only by platform-level bootstrapping... Feature 6's OnboardingModule").
// The signing-up user becomes the new tenant's first admin — there's no
// other user yet to invite them, and every subsequent team-invite (this
// module, next slice) needs an existing admin to have invited them.
import { ConflictException, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { BillingService } from '../billing/billing.service';
import { CatalogToolSeederService } from '../catalog/catalog-tool-seeder.service';
import { CourierToolSeederService } from '../courier/courier-tool-seeder.service';
import { AppConfigService, AppLoggerService } from '../core';
import { tenants } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { TenantAuthProvisioningPort } from './ports/tenant-auth-provisioning.port';
import type { TenantProvisioningResult } from './tenant-provisioning.dto';

@Injectable()
export class TenantProvisioningService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly provisioning: TenantAuthProvisioningPort,
    private readonly config: AppConfigService,
    private readonly billing: BillingService,
    private readonly catalogToolSeeder: CatalogToolSeederService,
    private readonly courierToolSeeder: CourierToolSeederService,
    private readonly logger: AppLoggerService,
  ) {}

  async signUp(
    userId: string,
    tenantName: string,
    existingTenantId?: string,
  ): Promise<TenantProvisioningResult> {
    // The token's claim is checked first because it is free, but it is only
    // a snapshot — the caller may have signed up already and still be
    // holding the token they had before their claims were written. The
    // authoritative answer comes from the auth provider.
    if (
      existingTenantId ??
      (await this.provisioning.findAssignedTenantId(userId))
    ) {
      throw new ConflictException(
        'This user already belongs to a tenant — sign-up is one-time per user.',
      );
    }

    const [tenant] = await this.persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ name: tenantName }).returning(),
    );

    // The tenant row is already committed at this point, so a failure to
    // write the claims would leave a workspace nobody can reach — and the
    // caller, seeing a 500, would retry and strand another one on every
    // attempt. Undo the insert instead: signup either produces a workspace
    // its owner can sign into, or it produces nothing.
    try {
      await this.provisioning.assignTenantClaims(userId, tenant.id, 'admin');
    } catch (error) {
      await this.persistence.runAdminQuery((db) =>
        db.delete(tenants).where(eq(tenants.id, tenant.id)),
      );
      throw error;
    }

    // Launch billing backend (Lane A): a local trial row, no Stripe
    // interaction. Deliberately NOT inside the try/catch above — the
    // tenant and its claims are already fully committed at this point, and
    // a trial-row failure must not undo a workspace the user can already
    // sign into. Best-effort: logged and swallowed rather than failing
    // signup, since the launch-day backfill (migration 0043) and this
    // app's "no subscription row is a documented block, not a crash" T17/
    // Lane-A posture both mean a tenant that ends up here without a trial
    // row is a real, but non-fatal, gap to fix (comp it, or retry) rather
    // than a reason to have refused the signup that already succeeded.
    try {
      await this.billing.startLocalTrial(tenant.id);
    } catch (error) {
      this.logger.error(
        `signup for tenant ${tenant.id} succeeded but starting its local trial failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'TenantProvisioningService',
      );
    }

    // F20: enable the `lookup_product` agent tool for the new workspace.
    // Same best-effort posture (and same reasoning) as the trial row above —
    // the tenant is already committed, and an agent without the catalog tool
    // is degraded, not broken. Re-runnable: the seed is an upsert.
    await this.catalogToolSeeder.seedForTenantBestEffort(tenant.id);

    // F26 (D4): the same for `track_order`. Migration 0060 backfills every
    // tenant that already existed; this is the half that keeps NEW tenants
    // from being the ones the tool is unreachable for.
    await this.courierToolSeeder.seedForTenantBestEffort(tenant.id);

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      claimsAssigned: this.config.tenantProvisioningProvider === 'supabase',
    };
  }
}
