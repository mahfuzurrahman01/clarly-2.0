// A1/D3: "per-tenant partition + HNSW lifecycle." Creating a partition
// registers it under kb_chunks' already-existing partitioned HNSW/GIN
// indexes automatically (verified empirically against a real Postgres —
// see docs/decisions/F3-agent-core.md) — this service's only job is to
// create (once per tenant, idempotent) and drop that partition.
//
// The DDL itself lives in migration 0064's SECURITY DEFINER functions,
// public.ensure_kb_partition(uuid) and public.drop_kb_partition(uuid),
// because app_user cannot run it: both need ownership of kb_chunks. They are
// called through TenantContextService.withTenantTx() like any other query
// (rule 4: only PersistenceModule/TenantContextModule may open a raw DB
// connection — RetrievalModule imports TenantContextModule only).
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantContextService } from '../tenant-context/tenant-context.service';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PartitionLifecycleService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** Idempotent — `IF NOT EXISTS` makes repeated calls for the same tenant a no-op, so callers don't need to track "have I already ensured this tenant's partition" themselves. */
  async ensurePartitionForTenant(tenantId: string): Promise<void> {
    if (!UUID_PATTERN.test(tenantId)) {
      // Defensive: tenantId reaching this point should always already be a
      // validated UUID (FK-constrained elsewhere). It is now a bound parameter
      // and the function builds the identifier with format(%I), so this is
      // defence in depth plus a clearer error than Postgres' uuid cast gives.
      throw new Error(
        `ensurePartitionForTenant: tenantId is not a valid UUID: ${tenantId}`,
      );
    }

    // The DDL runs inside migration 0064's SECURITY DEFINER function, not
    // here: the API connects as `app_user`, which does not own `kb_chunks`,
    // and `CREATE TABLE ... PARTITION OF` requires ownership of the parent
    // (42501 "must be owner of table kb_chunks", found by the L2 eval). The
    // function also gives the new partition its own copy of the parent's
    // isolation policy with FORCE RLS — Postgres does not inherit RLS from a
    // partitioned parent, so a partition without it is readable cross-tenant
    // by any query that names it directly.
    await this.tenantContext.withTenantTx(async (tx) => {
      await tx.execute(
        sql`SELECT public.ensure_kb_partition(${tenantId}::uuid)`,
      );
    }, tenantId);
  }

  /**
   * Drops a tenant's partition outright — offboarding only.
   *
   * `kb_chunks` is a PARTITIONED table, not a child of `tenants`, so nothing
   * about deleting the tenant row reaches it. Without this the partition
   * survives every offboarding as an orphan holding that tenant's embedded
   * knowledge-base content, which is precisely the data an erasure request is
   * about.
   *
   * `IF EXISTS` because a tenant that never uploaded a document never had a
   * partition, and offboarding must not fail on the tidiest possible account.
   */
  async dropPartitionForTenant(tenantId: string): Promise<void> {
    // Same guard as above.
    if (!UUID_PATTERN.test(tenantId)) {
      throw new Error(
        `dropPartitionForTenant: tenantId is not a valid UUID: ${tenantId}`,
      );
    }

    // `DROP TABLE` needs ownership of the partition, which `app_user` lacks
    // for the same reason as above — see migration 0064.
    await this.tenantContext.withTenantTx(async (tx) => {
      await tx.execute(sql`SELECT public.drop_kb_partition(${tenantId}::uuid)`);
    }, tenantId);
  }
}
