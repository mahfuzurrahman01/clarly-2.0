import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { tenants } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type {
  TenantDirectoryEntry,
  UpdateTenantProfileBody,
} from './tenant-directory.dto';

const PROFILE_COLUMNS = {
  id: tenants.id,
  name: tenants.name,
  vertical: tenants.vertical,
  country: tenants.country,
  currency: tenants.currency,
  defaultLocale: tenants.defaultLocale,
} as const;

@Injectable()
export class TenantDirectoryService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * The named tenant, or null when no such row exists — a tenant id that
   * verified on the JWT but has since been deleted, which is a stale session
   * rather than a server fault. There is no variant of this method that reads
   * a tenant other than the one named, by design.
   */
  async getById(tenantId: string): Promise<TenantDirectoryEntry | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select(PROFILE_COLUMNS)
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1),
      tenantId,
    );

    return rows[0] ?? null;
  }

  /**
   * v2 S1: the workspace profile an admin edits in Settings → Workspace.
   * Returns null when the row is gone (stale session), same as getById.
   *
   * `tenants` has no RLS, so the `where` on the caller's own id is the only
   * thing scoping this UPDATE — the spec asserts it is always present.
   */
  async updateProfile(
    tenantId: string,
    patch: UpdateTenantProfileBody,
  ): Promise<TenantDirectoryEntry | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(tenants)
          .set(patch)
          .where(eq(tenants.id, tenantId))
          .returning(PROFILE_COLUMNS),
      tenantId,
    );
    return rows[0] ?? null;
  }
}
