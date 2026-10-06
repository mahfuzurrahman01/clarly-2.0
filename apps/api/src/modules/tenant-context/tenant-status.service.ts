// Is this tenant closed? Asked on every authenticated request, so the answer
// is cached.
//
// TenantAuthMiddleware did no database work at all before this — it verified a
// JWT and moved on. Adding an uncached lookup there would put a round trip in
// front of every console API call, which is a real regression to pay for a
// column that changes approximately never.
//
// So: a tiny TTL cache. A closed tenant keeps working for at most one TTL
// after closing, which is the honest trade and a far smaller window than the
// alternative already accepted elsewhere in this codebase — F15's member
// removal relies on claim revocation, which only takes effect when the token
// next refreshes, typically an hour. Closing also revokes claims, so this
// cache narrows that window rather than widening anything.
//
// Lives in TenantContextModule rather than with the offboarding code because
// TenantAuthMiddleware needs it, and AuthModule already imports this module —
// the other direction would be a cycle. It also fits the enforced rule that
// only PersistenceModule and TenantContextModule may reach the database
// directly.
//
// Deliberately a plain Map, not Redis: the value is cheap to recompute, a
// cold cache is correct rather than merely safe, and per-instance caching
// needs no invalidation protocol between instances. The entry is dropped
// eagerly on close and reopen so the acting admin sees their own change
// immediately on the instance that served it.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { tenants } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';

/** Short enough that a closed tenant stops within seconds, long enough that the lookup is rare. */
export const TENANT_STATUS_TTL_MS = 30_000;

interface CacheEntry {
  closed: boolean;
  expiresAt: number;
}

@Injectable()
export class TenantStatusService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly persistence: PersistenceService) {}

  /**
   * True when the tenant has been closed and is awaiting erasure.
   *
   * A tenant id that no longer exists also reports closed: the row is gone
   * because the purge already ran, and a token still carrying that id must not
   * be honoured. Fails closed, in other words, which is the only safe default
   * for a question about whether an account still exists.
   */
  async isClosed(tenantId: string, now: number = Date.now()): Promise<boolean> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.closed;

    const [row] = await this.persistence.runAdminQuery((db) =>
      db
        .select({ closedAt: tenants.closedAt })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    );

    const closed = !row || row.closedAt !== null;
    this.cache.set(tenantId, { closed, expiresAt: now + TENANT_STATUS_TTL_MS });
    return closed;
  }

  /** Called by close() and reopen() so the admin who acted sees it take effect at once. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
