// F25 D1.4: the approval-window sweep.
//
// Every open tenant is entered in turn (bounded concurrency, per-tenant
// failure isolation — `sweep-tenants.ts`), and its approval window is read
// INSIDE its own tenant transaction. Reading `tenant_order_settings`
// platform-wide first (the old shape) returned nothing under FORCE RLS and a
// NOBYPASSRLS role, so no order ever expired (fixed in Clarly 2.0). A tenant
// without a settings row has never enabled ordering and costs one indexed
// lookup.
import { Injectable } from '@nestjs/common';
import { AppLoggerService, sweepTenantsWithBoundedConcurrency } from '../core';
import { eq } from 'drizzle-orm';
import { tenantOrderSettings } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { TenantDirectoryService } from '../tenant-context/tenant-directory';
import { OrderApprovalService } from './order-approval.service';

@Injectable()
export class OrderExpiryService {
  constructor(
    private readonly tenants: TenantDirectoryService,
    private readonly tenantContext: TenantContextService,
    private readonly approvals: OrderApprovalService,
    private readonly logger: AppLoggerService,
  ) {}

  /** Returns how many orders were expired across every tenant this cycle. */
  async sweepAllTenants(): Promise<number> {
    const results = await sweepTenantsWithBoundedConcurrency(
      await this.tenants.listTenantIds(),
      async (tenantId) => {
        const [settings] = await this.tenantContext.withTenantTx(
          (tx) =>
            tx
              .select({
                approvalWindowHours: tenantOrderSettings.approvalWindowHours,
              })
              .from(tenantOrderSettings)
              .where(eq(tenantOrderSettings.tenantId, tenantId))
              .limit(1),
          tenantId,
        );
        if (!settings) return 0;
        return this.approvals.expireOverdue(
          tenantId,
          settings.approvalWindowHours ?? 24,
        );
      },
      { logger: this.logger, sweepName: 'order-expiry' },
    );

    return results.reduce((total, result) => total + (result.value ?? 0), 0);
  }
}
