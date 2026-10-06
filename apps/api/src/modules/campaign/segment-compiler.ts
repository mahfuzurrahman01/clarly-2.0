// F19 (D1): turns a validated segment tree into Drizzle SQL through a
// per-kind WHITELIST function. Every literal is a bound parameter — there is
// no code path that interpolates a definition value into SQL text — and a
// criterion kind with no compiler entry throws rather than falling through
// (silently matching nothing, or worse, everything).
//
// Callers MUST re-validate with `parseSegmentDefinition()` immediately
// before compiling (D1: "validated on every write and again on every read
// before compilation") — this module trusts its input's shape.
import { and, eq, inArray, not, or, sql, type SQL } from 'drizzle-orm';
import {
  conversations,
  customerLabels,
  customers,
  orders,
} from '../persistence/drizzle/schema';
import {
  REALISED_ORDER_STATUSES,
  type SegmentCriterion,
  type SegmentCriterionKind,
  type SegmentNode,
} from './segment-definition.schema';

/**
 * Thrown for a criterion the grammar accepts but this module cannot compile
 * yet. No kind is in that state today — the four F25 order-history criteria
 * were the last ones and they compile as of F19/F25 wiring — but the class is
 * kept as the documented escape hatch: a kind added to the grammar ahead of
 * its compiler throws here rather than silently matching nothing (or, worse,
 * everything).
 */
export class SegmentCriterionNotImplementedError extends Error {
  constructor(public readonly kind: SegmentCriterionKind) {
    super(
      `Segment criterion "${kind}" is accepted by the grammar but has no ` +
        `compiler implementation. See docs/decisions/F19-campaigns-broadcast.md D1.`,
    );
    this.name = 'SegmentCriterionNotImplementedError';
  }
}

/** Thrown when a node's `kind` is not in {@link CRITERION_COMPILERS} at all — a defect, never expected in Zod-valid input. */
export class UnknownSegmentCriterionError extends Error {
  constructor(kind: string) {
    super(`Unknown segment criterion kind: "${kind}"`);
    this.name = 'UnknownSegmentCriterionError';
  }
}

/**
 * The correlation every order-history criterion shares: this customer's
 * orders, in this tenant, that actually represent a purchase.
 *
 * Three properties, all load-bearing:
 *
 * 1. **Tenant scoping.** `orders.tenant_id = customers.tenant_id` is part of
 *    every order subquery, exactly as the `label` and `last_inbound_*`
 *    criteria scope theirs. The outer resolve is already pinned to one
 *    tenant and RLS is forced on `orders`, but a segment resolves to an
 *    audience that gets *messaged* — the correlation is written explicitly so
 *    no single failure (a mis-set RLS GUC, a future caller that forgets the
 *    outer filter) can widen the audience across tenants. It is also the
 *    leading column of `orders_tenant_customer_idx`.
 * 2. **Realised states only** (F19 D1). `pending_approval`, `rejected`,
 *    `expired`, `cancelled` and `failed` are NOT purchases — a rejected draft
 *    must never make someone a "customer who has ordered". The list is F25's
 *    vocabulary, pinned in one named constant so a change there is one edit
 *    with one failing test, not silent audience drift.
 * 3. **No N+1.** This is a correlated subquery inside the resolve's own
 *    `WHERE` — one statement per page of customers, never one query per
 *    customer (D1 step 3; N+1 here is a review-blocking defect).
 */
function realisedOrdersCorrelation(): SQL {
  return and(
    eq(orders.tenantId, customers.tenantId),
    eq(orders.customerId, customers.id),
    inArray(orders.status, [...REALISED_ORDER_STATUSES]),
  )!;
}

type CriterionCompiler<K extends SegmentCriterionKind> = (
  criterion: Extract<SegmentCriterion, { kind: K }>,
) => SQL;

/** The whitelist. One entry per `SegmentCriterionKind` — the compiler's exhaustiveness check below fails to build if a kind is ever added to the grammar without a matching entry here. */
const CRITERION_COMPILERS: {
  [K in SegmentCriterionKind]: CriterionCompiler<K>;
} = {
  label: (c) =>
    sql`EXISTS (SELECT 1 FROM ${customerLabels} WHERE ${and(
      eq(customerLabels.tenantId, customers.tenantId),
      eq(customerLabels.customerId, customers.id),
      inArray(customerLabels.label, c.in),
    )})`,

  tag: (c) =>
    sql`${customers.tags} ?| array[${sql.join(
      c.hasAny.map((value) => sql`${value}`),
      sql`, `,
    )}]::text[]`,

  channel: (c) => inArray(customers.channel, c.in),

  customer_created: (c) =>
    sql`${customers.createdAt} >= now() - make_interval(days => ${c.within_days})`,

  customer_created_before: (c) =>
    sql`${customers.createdAt} <= now() - make_interval(days => ${c.days_ago})`,

  last_inbound_within_days: (c) =>
    sql`EXISTS (SELECT 1 FROM ${conversations} WHERE ${and(
      eq(conversations.tenantId, customers.tenantId),
      eq(conversations.channel, customers.channel),
      eq(conversations.customerPhone, customers.phone),
      sql`${conversations.lastInboundAt} >= now() - make_interval(days => ${c.days})`,
    )})`,

  // A customer with no conversation at all has, by construction, never had
  // an inbound "recently" — treated as satisfying "before N days ago"
  // (dormant/never-engaged), same as never_ordered's fail-open reasoning.
  last_inbound_before_days: (c) =>
    or(
      not(
        sql`EXISTS (SELECT 1 FROM ${conversations} WHERE ${and(
          eq(conversations.tenantId, customers.tenantId),
          eq(conversations.channel, customers.channel),
          eq(conversations.customerPhone, customers.phone),
        )})`,
      ),
      sql`EXISTS (SELECT 1 FROM ${conversations} WHERE ${and(
        eq(conversations.tenantId, customers.tenantId),
        eq(conversations.channel, customers.channel),
        eq(conversations.customerPhone, customers.phone),
        sql`${conversations.lastInboundAt} <= now() - make_interval(days => ${c.days})`,
      )})`,
    )!,

  // F25 order history. `count(*)` over an empty set is 0, not NULL, so a
  // customer with no realised orders correctly satisfies `lte 0` and fails
  // `gte 1` — no COALESCE needed, and no customer silently drops out of a
  // `lte` segment for want of an order row.
  order_count: (c) => {
    const count = sql`(SELECT count(*) FROM ${orders} WHERE ${realisedOrdersCorrelation()})`;
    return c.op === 'gte'
      ? sql`${count} >= ${c.value}`
      : sql`${count} <= ${c.value}`;
  },

  // `sum()` over an empty set IS NULL, so the COALESCE is what keeps a
  // never-ordered customer in a `lte` segment instead of dropping them on a
  // NULL comparison. Totals are summed in `orders.currency` as stored: F25 is
  // single-currency per tenant and there is no FX table, so this is a sum of
  // the tenant's own currency despite the `_usd` suffix the grammar froze.
  order_total_usd: (c) => {
    const total = sql`(SELECT coalesce(sum(${orders.total}), 0) FROM ${orders} WHERE ${realisedOrdersCorrelation()})`;
    return c.op === 'gte'
      ? sql`${total} >= ${c.value}`
      : sql`${total} <= ${c.value}`;
  },

  // "Has a realised order newer than N days" — EXISTS, not MAX(created_at),
  // because the planner can stop at the first matching row.
  last_order_within_days: (c) =>
    sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${and(
      realisedOrdersCorrelation(),
      sql`${orders.createdAt} >= now() - make_interval(days => ${c.days})`,
    )})`,

  // The exact complement of "has ever ordered": a customer whose only orders
  // are pending_approval/rejected/expired/cancelled/failed has never bought
  // anything and IS never_ordered.
  never_ordered: () =>
    not(
      sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${realisedOrdersCorrelation()})`,
    ),
};

function compileCriterion(criterion: SegmentCriterion): SQL {
  const compiler = CRITERION_COMPILERS[criterion.kind];
  if (!compiler) {
    throw new UnknownSegmentCriterionError(criterion.kind);
  }
  // Each compiler is typed against its own criterion shape; the whitelist
  // lookup above is the runtime guarantee that the right one runs. TS
  // narrows the lookup to an intersection of every compiler signature, which
  // reduces `criterion` to `never` — the cast re-widens it and is NOT
  // redundant, despite what no-unnecessary-type-assertion infers.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return (compiler as (c: SegmentCriterion) => SQL)(criterion);
}

/**
 * Compiles a validated {@link SegmentNode} tree into one boolean SQL
 * expression, suitable for a `.where()` alongside `customers.tenantId`.
 */
export function compileSegmentCondition(node: SegmentNode): SQL {
  if (node.kind === 'and') {
    return and(...node.children.map(compileSegmentCondition))!;
  }
  if (node.kind === 'or') {
    return or(...node.children.map(compileSegmentCondition))!;
  }
  if (node.kind === 'not') {
    return not(compileSegmentCondition(node.child));
  }
  return compileCriterion(node);
}
