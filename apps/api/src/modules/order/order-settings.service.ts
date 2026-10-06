// F25 D1.1/D1.5: the per-tenant order mode, and the deliberate opt-in that is
// the only way to reach unattended ordering.
//
// Auto mode is NEVER granted automatically, never by the platform, and never
// as a side effect of anything. It requires an explicit PATCH from an admin,
// and the five criteria in D1.5 are re-computed at the moment of the call.
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  orders,
  products,
  storeConnections,
  tenantOrderSettings,
  type OrderMode,
} from '../persistence/drizzle/schema';
import {
  DEFAULT_APPROVAL_WINDOW_HOURS,
  DEFAULT_ORDER_MODE,
} from '../persistence/drizzle/tenant-order-settings.table';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { Clock } from '../core';

/** The thresholds are a PRODUCT call (F25 "Open questions" 1); the mechanism does not change if they move. */
export const AUTO_MODE_MIN_DAYS_IN_HUMAN_APPROVAL = 7;
export const AUTO_MODE_MIN_DECIDED_ORDERS = 20;
export const AUTO_MODE_MAX_REJECTION_RATE = 0.05;

export interface OrderSettingsRecord {
  tenantId: string;
  mode: OrderMode;
  codEnabled: boolean;
  approvalWindowHours: number;
  autoEnabledAt: Date | null;
  autoEnabledBy: string | null;
  autoEligibilitySnapshot: Record<string, unknown> | null;
}

/**
 * QA 2026-10-05: a stable, locale-free name for what a criterion measured, so
 * the console can render it in the operator's language. Differs from `key` for
 * `catalog_ready`, whose code says WHICH catalogue condition was checked.
 */
export type AutoEligibilityCode =
  | 'human_approval_days'
  | 'approved_orders_count'
  | 'rejection_rate'
  | 'active_products'
  | 'products_linked'
  | 'store_connected'
  | 'cod_enabled';

export type AutoEligibilityUnit = 'days' | 'orders' | 'percent' | 'products';

export interface AutoEligibilityCriterion {
  key:
    | 'human_approval_tenure'
    | 'decided_orders'
    | 'rejection_rate'
    | 'catalog_ready'
    | 'cod_enabled';
  met: boolean;
  /** What the merchant needs to see: the number we measured and the number required. English; the console's fallback. */
  detail: string;
  code: AutoEligibilityCode;
  /** The bar. For `rejection_rate` it is an exclusive MAXIMUM (actual must be below it); every other number is a minimum. */
  required: number | boolean;
  /** What was measured, in the same unit as `required`. */
  actual: number | boolean;
  unit: AutoEligibilityUnit | null;
  /** Any other value the English `detail` interpolates. */
  params: Record<string, string | number>;
}

type CriterionMeasure = Omit<AutoEligibilityCriterion, 'key'>;

export interface AutoEligibility {
  eligible: boolean;
  criteria: AutoEligibilityCriterion[];
  measuredAt: string;
}

export interface UpdateOrderSettingsInput {
  mode?: OrderMode;
  codEnabled?: boolean;
  approvalWindowHours?: number;
}

/** The settings a tenant with no row has: disabled, fail closed (D1.1). */
export function defaultOrderSettings(tenantId: string): OrderSettingsRecord {
  return {
    tenantId,
    mode: DEFAULT_ORDER_MODE,
    codEnabled: true,
    approvalWindowHours: DEFAULT_APPROVAL_WINDOW_HOURS,
    autoEnabledAt: null,
    autoEnabledBy: null,
    autoEligibilitySnapshot: null,
  };
}

@Injectable()
export class OrderSettingsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly clock: Clock,
  ) {}

  /** Absence IS a value: a tenant with no row reads as `disabled`. */
  async get(tenantId: string): Promise<OrderSettingsRecord> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tenantOrderSettings)
          .where(eq(tenantOrderSettings.tenantId, tenantId))
          .limit(1),
      tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : defaultOrderSettings(tenantId);
  }

  /**
   * Applies a settings change, refusing a move to `auto` unless every D1.5
   * criterion holds at this moment. A 422 names the failing criteria rather
   * than saying "not eligible" — a merchant who cannot see which number is
   * short cannot do anything about it.
   */
  async update(
    tenantId: string,
    actorUserId: string,
    input: UpdateOrderSettingsInput,
  ): Promise<OrderSettingsRecord> {
    let snapshot: AutoEligibility | null = null;

    if (input.mode === 'auto') {
      snapshot = await this.evaluateAutoEligibility(tenantId);
      if (!snapshot.eligible) {
        throw new UnprocessableEntityException({
          message:
            'This workspace is not yet eligible for unattended ordering.',
          failedCriteria: snapshot.criteria
            .filter((criterion) => !criterion.met)
            .map((criterion) => ({
              criterion: criterion.key,
              detail: criterion.detail,
              code: criterion.code,
              required: criterion.required,
              actual: criterion.actual,
              unit: criterion.unit,
              params: criterion.params,
            })),
        });
      }
    }

    const now = this.clock.now();
    const enablingAuto = input.mode === 'auto';

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(tenantOrderSettings)
          .values({
            tenantId,
            mode: input.mode ?? DEFAULT_ORDER_MODE,
            ...(input.codEnabled === undefined
              ? {}
              : { codEnabled: input.codEnabled }),
            ...(input.approvalWindowHours === undefined
              ? {}
              : { approvalWindowHours: input.approvalWindowHours }),
            ...(enablingAuto
              ? {
                  autoEnabledAt: now,
                  autoEnabledBy: actorUserId,
                  autoEligibilitySnapshot: snapshot as unknown as Record<
                    string,
                    unknown
                  >,
                }
              : {}),
          })
          // Upsert rather than read-then-write: two admins saving the settings
          // page at once must not produce a duplicate-key 500.
          .onConflictDoUpdate({
            target: tenantOrderSettings.tenantId,
            set: {
              ...(input.mode === undefined ? {} : { mode: input.mode }),
              ...(input.codEnabled === undefined
                ? {}
                : { codEnabled: input.codEnabled }),
              ...(input.approvalWindowHours === undefined
                ? {}
                : { approvalWindowHours: input.approvalWindowHours }),
              ...(enablingAuto
                ? {
                    autoEnabledAt: now,
                    autoEnabledBy: actorUserId,
                    autoEligibilitySnapshot: snapshot as unknown as Record<
                      string,
                      unknown
                    >,
                  }
                : {}),
              updatedAt: now,
            },
          })
          .returning(),
      tenantId,
    );

    return toRecord(row);
  }

  /**
   * D1.5's five criteria, every one measured now. Returned whole (not just a
   * boolean) so `GET /orders/settings` can show a merchant exactly how far
   * they are from the gate, and so the snapshot written at opt-in time answers
   * "what did the numbers look like" a year later.
   */
  async evaluateAutoEligibility(tenantId: string): Promise<AutoEligibility> {
    const settings = await this.get(tenantId);
    const now = this.clock.now();

    const [decided, catalog] = await Promise.all([
      this.countDecidedOrders(tenantId),
      this.catalogReadiness(tenantId),
    ]);

    const inHumanApproval =
      settings.mode === 'human_approval' || settings.mode === 'auto';
    // The settings row's own age is the only continuous-tenure evidence this
    // schema carries; a mode that was flipped away and back resets it, which
    // is the conservative reading.
    const settingsRow = await this.settingsRowCreatedAt(tenantId);

    const criteria: AutoEligibilityCriterion[] = [
      {
        key: 'human_approval_tenure',
        ...tenureCriterion(settings.mode, inHumanApproval, settingsRow, now),
      },
      { key: 'decided_orders', ...decidedOrdersCriterion(decided.total) },
      { key: 'rejection_rate', ...rejectionRateCriterion(decided) },
      { key: 'catalog_ready', ...catalog },
      { key: 'cod_enabled', ...codCriterion(settings.codEnabled) },
    ];

    return {
      eligible: criteria.every((criterion) => criterion.met),
      criteria,
      measuredAt: now.toISOString(),
    };
  }

  private async settingsRowCreatedAt(tenantId: string): Promise<Date | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ createdAt: tenantOrderSettings.createdAt })
          .from(tenantOrderSettings)
          .where(eq(tenantOrderSettings.tenantId, tenantId))
          .limit(1),
      tenantId,
    );
    return rows[0]?.createdAt ?? null;
  }

  private async countDecidedOrders(
    tenantId: string,
  ): Promise<{ total: number; rejected: number }> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            status: orders.status,
            count: sql<number>`count(*)::int`,
          })
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, tenantId),
              inArray(orders.status, [
                'confirmed',
                'rejected',
                'fulfilled',
                'cancelled',
              ]),
            ),
          )
          .groupBy(orders.status),
      tenantId,
    );

    let total = 0;
    let rejected = 0;
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      total += count;
      if (row.status === 'rejected') rejected += count;
    }
    return { total, rejected };
  }

  /**
   * D1.5 criterion 4: at least one active product, and — if a store is
   * connected — at least one product linked to it. Otherwise every auto order
   * would silently fail its store push.
   */
  private async catalogReadiness(tenantId: string): Promise<CriterionMeasure> {
    const [activeProducts, connections, linkedProducts] =
      await this.tenantContext.withTenantTx(
        async (tx) => [
          await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(products)
            .where(
              and(eq(products.tenantId, tenantId), eq(products.isActive, true)),
            ),
          await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(storeConnections)
            .where(
              and(
                eq(storeConnections.tenantId, tenantId),
                eq(storeConnections.isActive, true),
              ),
            ),
          await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(products)
            .where(
              and(
                eq(products.tenantId, tenantId),
                eq(products.isActive, true),
                isNotNull(sql`${products.metadata} ->> 'storeExternalId'`),
              ),
            ),
        ],
        tenantId,
      );

    return catalogCriterion({
      activeProducts: Number(activeProducts[0]?.count ?? 0),
      storesConnected: Number(connections[0]?.count ?? 0),
      linkedProducts: Number(linkedProducts[0]?.count ?? 0),
    });
  }
}

// ---------------------------------------------------------------------------
// One builder per D1.5 criterion. Each returns the English `detail` (unchanged
// wording) together with the structured fields it was written from, so the two
// cannot drift.

function tenureCriterion(
  mode: OrderMode,
  inHumanApproval: boolean,
  settingsRowCreatedAt: Date | null,
  now: Date,
): CriterionMeasure {
  const days =
    settingsRowCreatedAt === null ? 0 : daysBetween(settingsRowCreatedAt, now);
  // Only time spent in an approval mode counts toward the bar.
  const actual = inHumanApproval ? days : 0;
  return {
    met: inHumanApproval && actual >= AUTO_MODE_MIN_DAYS_IN_HUMAN_APPROVAL,
    detail: `Requires ${AUTO_MODE_MIN_DAYS_IN_HUMAN_APPROVAL} days in human-approval mode; ${
      settingsRowCreatedAt === null
        ? 'ordering has never been enabled'
        : `enabled ${days} day(s) ago in mode "${mode}"`
    }.`,
    code: 'human_approval_days',
    required: AUTO_MODE_MIN_DAYS_IN_HUMAN_APPROVAL,
    actual,
    unit: 'days',
    params: { mode },
  };
}

function decidedOrdersCriterion(total: number): CriterionMeasure {
  return {
    met: total >= AUTO_MODE_MIN_DECIDED_ORDERS,
    detail: `Requires ${AUTO_MODE_MIN_DECIDED_ORDERS} approved-or-rejected orders; ${total} so far.`,
    code: 'approved_orders_count',
    required: AUTO_MODE_MIN_DECIDED_ORDERS,
    actual: total,
    unit: 'orders',
    params: {},
  };
}

function rejectionRateCriterion(decided: {
  total: number;
  rejected: number;
}): CriterionMeasure {
  const rate = decided.total === 0 ? 0 : decided.rejected / decided.total;
  const requiredPercent = AUTO_MODE_MAX_REJECTION_RATE * 100;
  return {
    met:
      decided.total >= AUTO_MODE_MIN_DECIDED_ORDERS &&
      rate < AUTO_MODE_MAX_REJECTION_RATE,
    detail: `Requires a rejection rate below ${requiredPercent.toFixed(0)}%; currently ${(rate * 100).toFixed(1)}% (${decided.rejected} of ${decided.total}).`,
    code: 'rejection_rate',
    required: requiredPercent,
    actual: Math.round(rate * 1000) / 10,
    unit: 'percent',
    params: { rejected: decided.rejected, decided: decided.total },
  };
}

/**
 * D1.5 criterion 4. The `code` names the condition that decided it: no active
 * product (`active_products`), a connected store and how many products are
 * linked to it (`products_linked`), or no store at all (`store_connected`,
 * which is not required — orders then stay in Clarly).
 */
function catalogCriterion(counts: {
  activeProducts: number;
  storesConnected: number;
  linkedProducts: number;
}): CriterionMeasure {
  const params = { ...counts };
  const { activeProducts: active, storesConnected: stores } = counts;
  const linked = counts.linkedProducts;

  if (active === 0) {
    return {
      met: false,
      detail: 'Requires at least one active catalogue product; there are none.',
      code: 'active_products',
      required: 1,
      actual: 0,
      unit: 'products',
      params,
    };
  }
  if (stores > 0) {
    return {
      met: linked > 0,
      detail:
        linked === 0
          ? 'A store is connected but no active product is linked to it — every automatic order would fail its store push.'
          : `${active} active product(s), ${linked} linked to a connected store.`,
      code: 'products_linked',
      required: 1,
      actual: linked,
      unit: 'products',
      params,
    };
  }
  return {
    met: true,
    detail: `${active} active product(s); no store connected, orders stay in Clarly.`,
    code: 'store_connected',
    required: false,
    actual: false,
    unit: null,
    params,
  };
}

function codCriterion(codEnabled: boolean): CriterionMeasure {
  return {
    met: codEnabled,
    detail: codEnabled
      ? 'Cash on delivery is enabled.'
      : 'Cash on delivery is the only phase-1 payment method and is currently disabled.',
    code: 'cod_enabled',
    required: true,
    actual: codEnabled,
    unit: null,
    params: {},
  };
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

function toRecord(
  row: typeof tenantOrderSettings.$inferSelect,
): OrderSettingsRecord {
  return {
    tenantId: row.tenantId,
    mode: row.mode as OrderMode,
    codEnabled: row.codEnabled,
    approvalWindowHours: row.approvalWindowHours,
    autoEnabledAt: row.autoEnabledAt,
    autoEnabledBy: row.autoEnabledBy,
    autoEligibilitySnapshot: row.autoEligibilitySnapshot ?? null,
  };
}
