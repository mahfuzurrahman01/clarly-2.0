// Clarly 2.0 S1/S5: what the operator console knows about tenants.
//
// HOW AN OPERATOR READS ACROSS TENANTS WITHOUT BYPASSING RLS
// ---------------------------------------------------------
// The tenant directory (`tenants`) is a platform table with no RLS, so the
// list itself is one query. Everything per-tenant (subscription, usage) lives
// in FORCE-RLS tables, and is read ONE TENANT AT A TIME through the same
// `withTenantTx()` every tenant request uses. There is no BYPASSRLS role, no
// SECURITY DEFINER aggregate and no second connection pool: an operator sees
// a tenant's rows exactly the way that tenant's own session would. That keeps
// the isolation proof unchanged (docs/v2/ARCHITECTURE.md §5) at the cost of N
// small transactions per page, which is fine for a page of at most 50 rows on
// a console used by a handful of people.
import { Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { AppLoggerService, sweepTenantsWithBoundedConcurrency } from '../core';
import {
  agentRuns,
  plans,
  tenants,
  tenantSubscriptions,
  type TenantLocale,
  type TenantVertical,
} from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';

export interface PlatformTenantSubscription {
  status: string;
  planName: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  comped: boolean;
}

export interface PlatformTenantUsage {
  /** Agent turns in the trailing 30 days, excluding `error` runs (same rule as UsageService). */
  turns30d: number;
  costUsd30d: number;
}

export interface PlatformTenantSummary {
  id: string;
  name: string;
  vertical: TenantVertical;
  country: string | null;
  currency: string | null;
  defaultLocale: TenantLocale;
  createdAt: Date;
  closedAt: Date | null;
  subscription: PlatformTenantSubscription | null;
  /** Null when this tenant's usage could not be read this time (logged); the row is still listed. */
  usage: PlatformTenantUsage | null;
}

export interface PlatformTenantPage {
  items: PlatformTenantSummary[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

const MAX_PAGE_SIZE = 50;
const PER_TENANT_CONCURRENCY = 4;
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `<createdAt with microseconds>|<uuid>` — keyset on (created_at DESC, id DESC)
 * so pages are stable while tenants sign up.
 *
 * The timestamp is carried as Postgres's own microsecond text, never through
 * a JS `Date`: `Date` keeps milliseconds only, and rows inserted in one
 * statement share a `now()` whose microseconds a millisecond cursor cannot
 * express. The second page then compares `12:00:00.123456 < 12:00:00.123`,
 * finds nothing, and silently ends the list (caught by
 * platform.integration-spec.ts).
 */
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeTenantCursor(
  createdAtMicros: string,
  id: string,
): string {
  return Buffer.from(`${createdAtMicros}|${id}`).toString('base64url');
}

export function decodeTenantCursor(
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const [ts, id, ...rest] = Buffer.from(cursor, 'base64url')
      .toString('utf8')
      .split('|');
    if (rest.length > 0 || !ts || !id) return null;
    if (!CURSOR_TS.test(ts) || !UUID_RE.test(id)) return null;
    return { createdAt: ts, id };
  } catch {
    return null;
  }
}

/** Microsecond-exact UTC text of `created_at`, for the cursor. */
const CREATED_AT_MICROS = sql<string>`to_char(${tenants.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Escapes LIKE metacharacters so a search for `50%` means the text "50%". */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly tenantContext: TenantContextService,
    private readonly logger: AppLoggerService,
  ) {}

  async list(options: {
    search?: string;
    limit?: number;
    cursor?: string;
    now?: Date;
  }): Promise<PlatformTenantPage> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), MAX_PAGE_SIZE);
    const after = options.cursor ? decodeTenantCursor(options.cursor) : null;
    const search = options.search?.trim();

    const conditions: (SQL | undefined)[] = [];
    if (search) {
      const pattern = `%${escapeLike(search)}%`;
      conditions.push(
        UUID_RE.test(search)
          ? or(ilike(tenants.name, pattern), eq(tenants.id, search))
          : ilike(tenants.name, pattern),
      );
    }
    if (after) {
      const ts = sql`${after.createdAt}::timestamptz`;
      conditions.push(
        or(
          sql`${tenants.createdAt} < ${ts}`,
          and(sql`${tenants.createdAt} = ${ts}`, lt(tenants.id, after.id)),
        ),
      );
    }

    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({ tenant: tenants, cursorTs: CREATED_AT_MICROS })
        .from(tenants)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(tenants.createdAt), desc(tenants.id))
        .limit(limit + 1),
    );

    const page = rows.slice(0, limit);
    const pageRows = page.map((r) => r.tenant);
    const details = await this.loadDetails(
      pageRows.map((r) => r.id),
      options.now ?? new Date(),
    );

    const items = pageRows.map((row) => {
      const detail = details.get(row.id);
      return {
        id: row.id,
        name: row.name,
        vertical: row.vertical,
        country: row.country,
        currency: row.currency,
        defaultLocale: row.defaultLocale,
        createdAt: row.createdAt,
        closedAt: row.closedAt,
        subscription: detail?.subscription ?? null,
        usage: detail?.usage ?? null,
      };
    });

    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeTenantCursor(last.cursorTs, last.tenant.id)
          : null,
    };
  }

  async get(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<PlatformTenantSummary | null> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    const detail = (await this.loadDetails([row.id], now)).get(row.id);
    return {
      id: row.id,
      name: row.name,
      vertical: row.vertical,
      country: row.country,
      currency: row.currency,
      defaultLocale: row.defaultLocale,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      subscription: detail?.subscription ?? null,
      usage: detail?.usage ?? null,
    };
  }

  private async loadDetails(
    tenantIds: string[],
    now: Date,
  ): Promise<
    Map<
      string,
      {
        subscription: PlatformTenantSubscription | null;
        usage: PlatformTenantUsage;
      }
    >
  > {
    const since = new Date(now.getTime() - USAGE_WINDOW_MS);
    const results = await sweepTenantsWithBoundedConcurrency(
      tenantIds,
      (tenantId) =>
        this.tenantContext.withTenantTx(async (tx) => {
          const [subscription] = await tx
            .select({
              status: tenantSubscriptions.status,
              planName: plans.name,
              trialEndsAt: tenantSubscriptions.trialEndsAt,
              currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
              cancelAtPeriodEnd: tenantSubscriptions.cancelAtPeriodEnd,
              comped: tenantSubscriptions.comped,
            })
            .from(tenantSubscriptions)
            .innerJoin(plans, eq(plans.id, tenantSubscriptions.planId))
            .where(eq(tenantSubscriptions.tenantId, tenantId))
            .limit(1);

          const [usage] = await tx
            .select({
              turns: sql<number>`count(*)::int`,
              cost: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float`,
            })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.tenantId, tenantId),
                ne(agentRuns.status, 'error'),
                gte(agentRuns.createdAt, since),
              ),
            );

          return {
            subscription: subscription ?? null,
            usage: {
              turns30d: usage?.turns ?? 0,
              costUsd30d: usage?.cost ?? 0,
            },
          };
        }, tenantId),
      {
        concurrency: PER_TENANT_CONCURRENCY,
        logger: this.logger,
        sweepName: 'platform-tenant-list',
      },
    );
    return new Map(results.map((r) => [r.tenantId, r.value]));
  }
}
