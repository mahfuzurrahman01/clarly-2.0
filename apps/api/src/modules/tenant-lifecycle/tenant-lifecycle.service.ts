// T16's remaining slice: full tenant offboarding.
//
// Closing an account is the most destructive thing a tenant admin can do, so
// it is two steps rather than one.
//
//   close()                                    purgeDue()  (scheduled sweep)
//     │                                              │
//     ├─ closedAt   = now      access stops here     │
//     └─ purgeAfter = now + grace                    │
//              │                                     │
//              └──── reopen() undoes it ─────────────┤
//                    (only inside this window)       │
//                                                    ▼
//                                              data is gone
//
// The grace window is not politeness. Deletion here is unrecoverable, and the
// endpoint that triggers it is exactly the one a compromised admin session
// would be used against.
//
// ORDER OF ERASURE — the sequence below is load-bearing, and getting it wrong
// leaks data silently rather than failing:
//
//   1. Collect storage keys FIRST. Twenty-two tables cascade from `tenants`,
//      including the `kb_documents` and `messages` rows that are the only
//      record of which stored objects belong to this tenant. Delete the tenant
//      first and those keys can never be found again — the files simply stay
//      in the bucket forever, unreferenced and unfindable. TranscriptPurge
//      learned this same lesson; it is repeated here because the failure is
//      invisible.
//   2. Delete the stored objects.
//   3. Drop the kb_chunks partition. It is a partition, not a child row, so no
//      cascade reaches it.
//   4. Cancel the subscription. Otherwise Stripe keeps billing a tenant whose
//      account no longer exists.
//   5. Revoke every member's tenant claims, so no token can be refreshed back
//      into a tenant that is about to vanish.
//   6. Delete the `tenants` row, and let the cascade do the rest.
//
// Steps 2-5 are all best-effort and logged on failure: none of them may block
// the row deletion. A tenant who asked to be erased must be erased even if
// Stripe is down, and a half-offboarded tenant that needs a human to finish it
// is worse than an erased one with a loud log line.
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { BillingService } from '../billing/billing.service';
import { AppConfigService, AppLoggerService } from '../core';
import { TenantAuthProvisioningPort } from '../onboarding/ports/tenant-auth-provisioning.port';
import { kbDocuments, messages, tenants } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { PartitionLifecycleService } from '../retrieval/partition-lifecycle.service';
import { ObjectStorage } from '../storage/ports/object-storage.port';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { TenantStatusService } from '../tenant-context/tenant-status.service';
import type { TenantClosureRecord } from './tenant-lifecycle.dto';

const MS_PER_DAY = 86_400_000;

@Injectable()
export class TenantLifecycleService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly tenantContext: TenantContextService,
    private readonly tenantStatus: TenantStatusService,
    private readonly storage: ObjectStorage,
    private readonly partitions: PartitionLifecycleService,
    private readonly billing: BillingService,
    private readonly provisioning: TenantAuthProvisioningPort,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Closes the account. Access stops now; data goes at `purgeAfter`.
   *
   * Not RLS-scoped, because `tenants` is not an RLS table — the caller's
   * tenant id comes off their verified token and is the only tenant this can
   * ever touch.
   */
  async close(tenantId: string): Promise<TenantClosureRecord> {
    const existing = await this.find(tenantId);
    if (!existing) throw new NotFoundException('Tenant not found');
    if (existing.closedAt) {
      throw new ConflictException(
        'This workspace is already closed. Reopen it if you did not mean to close it.',
      );
    }

    const closedAt = new Date();
    const purgeAfter = new Date(
      closedAt.getTime() + this.config.tenantPurgeGraceDays * MS_PER_DAY,
    );

    await this.persistence.runAdminQuery((db) =>
      db
        .update(tenants)
        .set({ closedAt, purgeAfter })
        .where(eq(tenants.id, tenantId)),
    );

    // The middleware's closed-check is TTL-cached; drop the entry so the admin
    // who just closed sees it take effect on their very next request rather
    // than waiting out a TTL on their own action.
    this.tenantStatus.invalidate(tenantId);

    this.logger.warn(
      `Tenant ${tenantId} closed. Data will be erased after ${purgeAfter.toISOString()} unless reopened.`,
      TenantLifecycleService.name,
    );

    return { tenantId, closedAt, purgeAfter };
  }

  /** Undoes a close, but only while the grace window is still open — after the sweep runs there is nothing left to reopen. */
  async reopen(tenantId: string): Promise<TenantClosureRecord> {
    const existing = await this.find(tenantId);
    if (!existing) throw new NotFoundException('Tenant not found');
    if (!existing.closedAt) {
      throw new ConflictException('This workspace is not closed.');
    }

    await this.persistence.runAdminQuery((db) =>
      db
        .update(tenants)
        .set({ closedAt: null, purgeAfter: null })
        .where(eq(tenants.id, tenantId)),
    );

    this.tenantStatus.invalidate(tenantId);

    this.logger.log(
      `Tenant ${tenantId} reopened before its purge deadline; no data was erased.`,
      TenantLifecycleService.name,
    );

    return { tenantId, closedAt: null, purgeAfter: null };
  }

  async getClosure(tenantId: string): Promise<TenantClosureRecord | null> {
    const row = await this.find(tenantId);
    if (!row) return null;
    return {
      tenantId,
      closedAt: row.closedAt,
      purgeAfter: row.purgeAfter,
    };
  }

  /** Every closed tenant whose grace window has run out. Driven by the scheduled sweep. */
  async purgeDue(now: Date = new Date()): Promise<{ purged: string[] }> {
    const due = await this.persistence.runAdminQuery((db) =>
      db
        .select({ id: tenants.id })
        .from(tenants)
        .where(
          and(isNotNull(tenants.purgeAfter), lte(tenants.purgeAfter, now)),
        ),
    );

    const purged: string[] = [];
    for (const tenant of due) {
      await this.purgeTenant(tenant.id);
      purged.push(tenant.id);
    }
    return { purged };
  }

  /**
   * Erases one tenant, in the order documented at the top of this file.
   *
   * Steps 2-5 are best-effort: a failure is logged and the erasure continues.
   * Leaving a tenant half-offboarded because Stripe timed out is worse than
   * finishing the job and shouting about the part that did not land.
   */
  async purgeTenant(tenantId: string): Promise<void> {
    // 1. BEFORE anything else — after the cascade there is no record of which
    //    stored objects were this tenant's.
    const storageKeys = await this.collectStorageKeys(tenantId);

    // 2.
    let objectsDeleted = 0;
    for (const key of storageKeys) {
      const ok = await this.bestEffort(
        tenantId,
        `delete stored object ${key}`,
        () => this.storage.delete(key),
      );
      if (ok) objectsDeleted += 1;
    }

    // 3. A partition, not a child row — no cascade reaches it.
    const partitionDropped = await this.bestEffort(
      tenantId,
      'drop kb_chunks partition',
      () => this.partitions.dropPartitionForTenant(tenantId),
    );

    // 4. Otherwise Stripe bills an account that no longer exists.
    await this.bestEffort(tenantId, 'cancel subscription', async () => {
      const subscription = await this.billing.getForTenant(tenantId);
      if (!subscription?.stripeSubscriptionId) return;
      if (subscription.status === 'canceled') return;
      await this.billing.cancelSubscription(tenantId, false);
    });

    // 5. No token may be refreshed back into a tenant that is about to vanish.
    await this.bestEffort(tenantId, 'revoke tenant claims', () =>
      this.revokeAllClaims(tenantId),
    );

    // 6. The cascade does the other twenty-two tables.
    await this.persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );

    // Reports what actually landed, not what was attempted. The earlier
    // version counted `storageKeys.length` regardless of outcome, so a run
    // where every delete failed still announced the objects were gone — the
    // failures were logged separately, but the summary contradicted them, in
    // exactly the situation someone would be reading these logs to find out
    // what survived.
    const leaked = storageKeys.length - objectsDeleted;
    this.logger.warn(
      `Tenant ${tenantId} erased: ${objectsDeleted}/${storageKeys.length} stored object(s) deleted, ` +
        `kb_chunks partition ${partitionDropped ? 'dropped' : 'NOT dropped'}, all cascading rows gone.` +
        (leaked > 0 || !partitionDropped
          ? ' SOME DATA SURVIVED — see the errors above; it needs manual cleanup and is now unreferenced.'
          : ''),
      TenantLifecycleService.name,
    );
  }

  /** Both tables that name a stored object. Read inside the tenant's own context, since both are RLS-scoped. */
  private async collectStorageKeys(tenantId: string): Promise<string[]> {
    return this.tenantContext.withTenantTx(async (tx) => {
      const documents = await tx
        .select({ storageKey: kbDocuments.storageKey })
        .from(kbDocuments)
        .where(eq(kbDocuments.tenantId, tenantId));
      const media = await tx
        .select({ storageKey: messages.mediaStorageKey })
        .from(messages)
        .where(eq(messages.tenantId, tenantId));

      return [
        ...documents.map((row) => row.storageKey),
        ...media.map((row) => row.storageKey),
      ].filter((key): key is string => typeof key === 'string' && key !== '');
    }, tenantId);
  }

  private async revokeAllClaims(tenantId: string): Promise<void> {
    const members = await this.provisioning.listTeamMembers(tenantId);
    for (const member of members) {
      await this.provisioning.revokeTenantClaims(member.userId);
    }
  }

  private async find(
    tenantId: string,
  ): Promise<{ closedAt: Date | null; purgeAfter: Date | null } | null> {
    const [row] = await this.persistence.runAdminQuery((db) =>
      db
        .select({ closedAt: tenants.closedAt, purgeAfter: tenants.purgeAfter })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    );
    return row ?? null;
  }

  /** Runs a step, and on failure logs loudly and carries on — see purgeTenant()'s note on why erasure must not stall. */
  private async bestEffort(
    tenantId: string,
    step: string,
    run: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      this.logger.error(
        `Offboarding tenant ${tenantId}: could not ${step} — continuing with erasure anyway. This needs manual cleanup: ${
          error instanceof Error ? error.message : String(error)
        }`,
        TenantLifecycleService.name,
      );
      return false;
    }
  }
}
