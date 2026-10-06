/**
 * L2 (docs/AGENT_LIVE_TEST_PLAN.md "Commerce tool eval"): per-corpus
 * `fixtures.json` — products, customers, existing orders and shipments —
 * seeded into the throwaway eval tenant ALONGSIDE the KB (runner.ts's
 * per-corpus setup pass), using the real repositories/services the respond
 * path itself writes through: `CatalogService`, `CustomerService`,
 * `OrderService`, `OrderApprovalService`, `CourierConnectionService` and
 * `ShipmentService`. No raw SQL duplicating their logic — the one deliberate
 * exception (terminal order statuses with no service mutation, documented at
 * its call site below) still goes through `TenantContextService.withTenantTx`,
 * the same RLS-scoped path every service uses, not an admin bypass.
 *
 * A corpus with no `fixtures.json` seeds nothing — every pre-L2 corpus is
 * unaffected.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import {
  orderItems,
  orders,
  shipments,
} from '../src/modules/persistence/drizzle/schema';
import type { ActualOrder } from './scoring';
import type { CatalogService } from '../src/modules/catalog/catalog.service';
import type { CatalogToolSeederService } from '../src/modules/catalog/catalog-tool-seeder.service';
import type { CustomerService } from '../src/modules/customer/customer.service';
import type { CourierConnectionService } from '../src/modules/courier/courier-connection.service';
import type { CourierToolSeederService } from '../src/modules/courier/courier-tool-seeder.service';
import type { ShipmentService } from '../src/modules/courier/shipment.service';
import type { OrderService } from '../src/modules/order/order.service';
import type { OrderApprovalService } from '../src/modules/order/order-approval.service';
import type { OrderSettingsService } from '../src/modules/order/order-settings.service';
import type { OrderToolSeederService } from '../src/modules/order/order-tool-seeder.service';
import type { TenantContextService } from '../src/modules/tenant-context/tenant-context.service';
import type { TenantToolRegistryService } from '../src/modules/tool-registry/tenant-tool-registry.service';
import { TOOL_DEFINITIONS } from '../src/modules/tool-execution/tool-definitions';
import type { CourierName } from '../src/modules/courier/ports/courier-connector.port';
import type { ShipmentStatus } from '../src/modules/persistence/drizzle/shipments.table';

/**
 * Stand-in actor id for every fixture-seeding call that takes an
 * `actorUserId`/`updatedBy` — those columns (`orders.approved_by` etc.) are
 * `uuid`, not `text`, so the literal `'eval-harness'` this file used to pass
 * failed at the DB with `invalid input syntax for type uuid`. Fixed rather
 * than random so a failed seed's rows are attributable to this harness on
 * inspection.
 */
const EVAL_HARNESS_ACTOR_ID = 'deadbeef-dead-4eef-8eef-deadbeefdead';

/** One catalog row. `variants` are additional rows sharing this entry's name/category as a prefix (schema has no separate variant table — see FIXTURE_FORMAT.md / the corpus-format spec for the exact convention). */
export interface FixtureProduct {
  name: string;
  nameAr?: string;
  sku: string;
  price: string;
  currency?: string;
  stock?: number;
  stockStatus?: 'in_stock' | 'low_stock' | 'out_of_stock' | 'pre_order';
  category?: string;
  variants?: FixtureProductVariant[];
}

export interface FixtureProductVariant {
  /** Appended to the parent's name, e.g. parent "Acme X200 Blender" + variantLabel "Black" -> "Acme X200 Blender - Black". */
  variantLabel: string;
  sku: string;
  price?: string;
  stock?: number;
  stockStatus?: FixtureProduct['stockStatus'];
}

export interface FixtureCustomer {
  phone: string;
  channel?: 'whatsapp' | 'messenger' | 'instagram';
}

export interface FixtureOrderItem {
  productSku: string;
  quantity: number;
}

export interface FixtureOrder {
  /** Index into `fixtures.customers`. */
  customerIndex: number;
  items: FixtureOrderItem[];
  status?:
    'pending_approval' | 'confirmed' | 'rejected' | 'cancelled' | 'fulfilled';
  contactName?: string;
  contactPhone?: string;
  address?: string;
  city?: string;
}

export interface FixtureShipment {
  /** Index into `fixtures.orders`. */
  orderIndex: number;
  courier: CourierName;
  trackingNumber: string;
  status: ShipmentStatus;
  /** Absolute ETA. Prefer `estimatedDeliveryInDays` for anything that is not already-delivered history. */
  estimatedDeliveryAt?: string;
  /**
   * ETA as a whole-day offset from the run date (0 = today, negative = late).
   * A hard-coded date goes stale the day after it is written (cycle 3:
   * AWB-100-2003's "out for delivery" ETA was already 2 days in the past).
   * Wins over `estimatedDeliveryAt` when both are set.
   */
  estimatedDeliveryInDays?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The shipment's ETA as a Date: the relative offset (anchored to 00:00 UTC of `now`'s day) if given, else the absolute string, else undefined. */
export function resolveShipmentEta(
  shipment: Pick<
    FixtureShipment,
    'estimatedDeliveryAt' | 'estimatedDeliveryInDays'
  >,
  now: Date = new Date(),
): Date | undefined {
  if (shipment.estimatedDeliveryInDays !== undefined) {
    const startOfDay = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    return new Date(startOfDay + shipment.estimatedDeliveryInDays * MS_PER_DAY);
  }
  return shipment.estimatedDeliveryAt
    ? new Date(shipment.estimatedDeliveryAt)
    : undefined;
}

export interface CorpusFixtures {
  products?: FixtureProduct[];
  customers?: FixtureCustomer[];
  orders?: FixtureOrder[];
  shipments?: FixtureShipment[];
  /** Per-corpus tool override — see "New corpora" L2 spec. Any tool omitted keeps its default (enabled). */
  tools?: {
    lookup_product?: boolean;
    create_order?: boolean;
    track_order?: boolean;
  };
}

export interface SeededProduct {
  id: string;
  sku: string;
  name: string;
  price: string;
  currency: string;
}

export interface SeededOrder {
  id: string;
  reference: string;
  customerId: string;
  customerIndex: number;
}

export interface SeededFixtures {
  /** Every catalog price actually seeded (base products + variants) — the price-hallucination check's ground truth. */
  catalogPrices: string[];
  productBySku: Map<string, SeededProduct>;
  /** Resolved customer ids, in `fixtures.customers` order. Index 0 is the default asking customer (EvalCase.customerIndex defaults to 0). */
  customerIds: string[];
  /** Same order as `customerIds` — the phone the runner uses to resolve the SAME conversation identity a real channel message would (customer and conversation are both keyed off the "from" phone in production). */
  customerPhones: string[];
  /** Resolved orders, in `fixtures.orders` order. */
  seededOrders: SeededOrder[];
  /** order reference / tracking number per customer INDEX other than the given one — EvalCase.otherCustomerRefs authoring convenience, not required (a corpus may hand-list its own). */
  refsByCustomerIndex: Map<number, string[]>;
}

export interface FixtureServices {
  catalog: CatalogService;
  catalogToolSeeder: CatalogToolSeederService;
  customers: CustomerService;
  orders: OrderService;
  orderApproval: OrderApprovalService;
  orderSettings: OrderSettingsService;
  orderToolSeeder: OrderToolSeederService;
  courierConnections: CourierConnectionService;
  courierToolSeeder: CourierToolSeederService;
  shipments: ShipmentService;
  tenantContext: TenantContextService;
  toolRegistry: TenantToolRegistryService;
}

/** Deterministic per-tenant courier credentials — never real ones; the fixture never calls a real courier (F26's whole ShipmentService path here is DB writes, not an HTTP call). */
function fixtureCourierAccountRef(tenantId: string): string {
  return `eval-${tenantId.slice(0, 8)}`;
}

/**
 * Shipments need a courier connection; ShipmentService never calls the courier
 * — these are DB writes only. Exported so the seeding of a status outside the
 * forward ladder (`exception`) is unit-testable without a full fixture run.
 */
export async function seedShipments(
  services: Pick<
    FixtureServices,
    'courierConnections' | 'shipments' | 'tenantContext'
  >,
  tenantId: string,
  shipmentFixtures: readonly FixtureShipment[],
  seededOrders: readonly SeededOrder[],
  refsByCustomerIndex: Map<number, string[]>,
): Promise<void> {
  const courierByName = new Map<CourierName, string>();
  for (const shipment of shipmentFixtures) {
    let courierConnectionId = courierByName.get(shipment.courier);
    if (!courierConnectionId) {
      const connection = await services.courierConnections.upsert({
        tenantId,
        courier: shipment.courier,
        accountRef: fixtureCourierAccountRef(tenantId),
        credentials: { evalFixture: 'true' },
        isActive: true,
      });
      courierConnectionId = connection.id;
      courierByName.set(shipment.courier, connection.id);
    }

    const order = seededOrders[shipment.orderIndex];
    if (!order) {
      throw new Error(
        `fixtures.shipments: orderIndex ${shipment.orderIndex} has no matching fixtures.orders entry`,
      );
    }

    const row = await services.shipments.create({
      tenantId,
      orderId: order.id,
      customerId: order.customerId,
      courierConnectionId,
      courier: shipment.courier,
      trackingNumber: shipment.trackingNumber,
    });

    if (shipment.status !== 'label_created') {
      const eta = resolveShipmentEta(shipment);
      const occurredAt = new Date();
      const outcome = await services.shipments.applyStatusEvents(
        tenantId,
        row.id,
        [
          {
            status: shipment.status,
            rawStatus: shipment.status,
            occurredAt,
          },
        ],
        'manual',
        eta,
      );
      // applyStatusEvents() only moves a shipment FORWARD along the ladder, and
      // `exception`/`unknown` sit outside it (isForwardTransition is false for
      // them), so a declared `exception` shipment silently seeded as
      // `label_created` and the corpus never tested a delayed/exception parcel
      // (cycle 3, AWB-100-2004). The event row above is already written; this
      // second deliberate direct write, through the same tenant-scoped tx every
      // service uses, sets the current status the fixture declared.
      if (outcome && outcome.currentStatus !== shipment.status) {
        await services.tenantContext.withTenantTx(
          (tx) =>
            tx
              .update(shipments)
              .set({
                currentStatus: shipment.status,
                currentStatusAt: occurredAt,
                updatedAt: new Date(),
              })
              .where(
                and(eq(shipments.id, row.id), eq(shipments.tenantId, tenantId)),
              ),
          tenantId,
        );
      }
      const refs = refsByCustomerIndex.get(order.customerIndex) ?? [];
      refs.push(shipment.trackingNumber);
      refsByCustomerIndex.set(order.customerIndex, refs);
    }
  }
}

export async function seedFixtures(
  services: FixtureServices,
  tenantId: string,
  fixtures: CorpusFixtures,
): Promise<SeededFixtures> {
  // --- tool rows: enabled by default (L2 spec item 2), per-corpus override ---
  await services.catalogToolSeeder.seedForTenant(tenantId);
  // human_approval, not auto: `auto` requires D1.5 eligibility (7 days'
  // tenure, 20 decided orders, <5% rejection...) that a throwaway eval
  // tenant can never satisfy. human_approval is enough to make `create_order`
  // reach L3 (OrderToolSeederService.syncForMode enables it for both modes) —
  // the tool call, its args and the written row are exactly the same either
  // way; only the resulting `orders.status` differs, which fixtures/expectOrder
  // account for explicitly.
  await services.orderSettings.update(tenantId, EVAL_HARNESS_ACTOR_ID, {
    mode: 'human_approval',
    codEnabled: true,
  });
  await services.orderToolSeeder.syncForMode(tenantId, 'human_approval');
  await services.courierToolSeeder.seedForTenant(tenantId);

  if (fixtures.tools) {
    for (const [name, enabled] of Object.entries(fixtures.tools)) {
      if (enabled === false) {
        await disableTool(services, tenantId, name);
      }
    }
  }

  // --- products (+ variants as sibling rows) ---
  const productBySku = new Map<string, SeededProduct>();
  const catalogPrices: string[] = [];
  for (const product of fixtures.products ?? []) {
    const row = await services.catalog.createProduct(tenantId, {
      name: product.name,
      nameAr: product.nameAr,
      sku: product.sku,
      price: Number(product.price),
      currency: product.currency ?? 'SAR',
      stock: product.stock ?? 0,
      stockStatus: product.stockStatus ?? 'in_stock',
      category: product.category,
    });
    productBySku.set(product.sku, {
      id: row.id,
      sku: product.sku,
      name: row.name,
      price: row.price,
      currency: row.currency,
    });
    catalogPrices.push(row.price);

    for (const variant of product.variants ?? []) {
      const variantRow = await services.catalog.createProduct(tenantId, {
        name: `${product.name} - ${variant.variantLabel}`,
        sku: variant.sku,
        price: Number(variant.price ?? product.price),
        currency: product.currency ?? 'SAR',
        stock: variant.stock ?? 0,
        stockStatus: variant.stockStatus ?? product.stockStatus ?? 'in_stock',
        category: product.category,
        metadata: { variantOf: product.sku },
      });
      productBySku.set(variant.sku, {
        id: variantRow.id,
        sku: variant.sku,
        name: variantRow.name,
        price: variantRow.price,
        currency: variantRow.currency,
      });
      catalogPrices.push(variantRow.price);
    }
  }

  // --- customers ---
  const customerIds: string[] = [];
  const customerPhones: string[] = [];
  for (const customer of fixtures.customers ?? []) {
    const row = await services.customers.getOrCreateByPhone(
      tenantId,
      customer.phone,
      customer.channel ?? 'whatsapp',
    );
    customerIds.push(row.id);
    customerPhones.push(customer.phone);
  }

  // --- orders (via OrderService.createFromTurn — the SAME write path create_order uses) ---
  const seededOrders: SeededOrder[] = [];
  const refsByCustomerIndex = new Map<number, string[]>();
  for (const [index, order] of (fixtures.orders ?? []).entries()) {
    const customerId = customerIds[order.customerIndex];
    if (!customerId) {
      throw new Error(
        `fixtures.orders[${index}]: customerIndex ${order.customerIndex} has no matching fixtures.customers entry`,
      );
    }
    const items = order.items.map((item) => {
      const product = productBySku.get(item.productSku);
      if (!product) {
        throw new Error(
          `fixtures.orders[${index}]: unknown productSku "${item.productSku}" — declare it in fixtures.products first`,
        );
      }
      return { productId: product.id, quantity: item.quantity };
    });

    const result = await services.orders.createFromTurn({
      tenantId,
      conversationId: null,
      customerId,
      // Unique per fixture row so two fixture orders never collide on the
      // idempotency key real turns also use (order-idempotency.ts).
      turnId: `eval-fixture-${randomUUID()}`,
      contactName: order.contactName ?? 'Eval Fixture Customer',
      contactPhone: order.contactPhone ?? 'unknown',
      address: order.address ?? 'Fixture address, no real delivery',
      city: order.city ?? null,
      notes: null,
      items,
      storeConnectionId: null,
      storeProvider: null,
    });

    const status = order.status ?? 'pending_approval';
    const orderId = result.order.id;
    if (status === 'confirmed' || status === 'fulfilled') {
      await services.orderApproval.approve(
        tenantId,
        orderId,
        EVAL_HARNESS_ACTOR_ID,
      );
    }
    if (status === 'rejected') {
      await services.orderApproval.reject(
        tenantId,
        orderId,
        EVAL_HARNESS_ACTOR_ID,
        'fixture: rejected for eval',
      );
    }
    if (status === 'cancelled') {
      // cancel() only transitions confirmed -> cancelled (order-status-transition.ts).
      await services.orderApproval.approve(
        tenantId,
        orderId,
        EVAL_HARNESS_ACTOR_ID,
      );
      await services.orderApproval.cancel(
        tenantId,
        orderId,
        EVAL_HARNESS_ACTOR_ID,
      );
    }
    if (status === 'fulfilled') {
      // No service mutation reaches `fulfilled` today (F25 has no
      // "mark delivered" endpoint — F26's shipment status is the
      // customer-facing signal instead). This is the one deliberate direct
      // write in this file, and it still goes through the tenant-scoped
      // transaction every service uses, not an admin bypass.
      await services.tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(orders)
            .set({ status: 'fulfilled', updatedAt: new Date() })
            .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId))),
        tenantId,
      );
    }

    seededOrders.push({
      id: orderId,
      reference: result.order.reference,
      customerId,
      customerIndex: order.customerIndex,
    });

    const refs = refsByCustomerIndex.get(order.customerIndex) ?? [];
    refs.push(result.order.reference);
    refsByCustomerIndex.set(order.customerIndex, refs);
  }

  await seedShipments(
    services,
    tenantId,
    fixtures.shipments ?? [],
    seededOrders,
    refsByCustomerIndex,
  );

  return {
    catalogPrices,
    productBySku,
    customerIds,
    customerPhones,
    seededOrders,
    refsByCustomerIndex,
  };
}

/**
 * A per-corpus `tools` override. `create_order` has its own seeder call that
 * already understands "disabled" (`OrderToolSeederService.syncForMode`);
 * `lookup_product`/`track_order` have no disabled state in production (they
 * are unconditionally seeded at signup), so this writes the row directly via
 * the registry with `enabled: false` and the SAME jsonSchema/description
 * `TOOL_DEFINITIONS` (and therefore `ToolExecutionService`) already enforces
 * — no parallel schema, per A2's "same object" rule.
 */
/**
 * L2 `--runs N` isolation: every order row that ALREADY exists on this
 * conversation, read once before a case's turns run. `runner.ts` seeds this
 * into `excludeOrderIds` alongside the fixture-seeded order ids.
 *
 * Without this, `--runs N > 1` (P0.1's median-of-N mode, used for exactly
 * this corpus family — see AGENT_LIVE_TEST_PLAN.md L1's `--runs 5`) re-runs
 * every case against the SAME conversation (same phone -> same
 * `conversations` row across runs), so an order a real `create_order` call
 * wrote in run 1 is still sitting there when run 2 starts. Without this
 * baseline, `findNewOrderForConversation`'s `excludeOrderIds` only knows
 * about the fixture-seeded orders (which carry `conversationId: null` and
 * never match this query anyway — see `seedFixtures()`), so run 2 would find
 * run 1's leftover order as "the newest order for this conversation" — a
 * false WRONG-ORDER fail on a run that correctly wrote no order, or a false
 * pass on a run that should have written one and silently didn't.
 */
export async function findExistingOrderIdsForConversation(
  tenantContext: TenantContextService,
  tenantId: string,
  conversationId: string,
): Promise<string[]> {
  const rows = await tenantContext.withTenantTx(
    (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.conversationId, conversationId),
          ),
        ),
    tenantId,
  );
  return rows.map((row) => row.id);
}

/**
 * `--runs N` isolation for order cases. Every run reuses the case's
 * conversation, and OrderService deliberately refuses a second identical
 * PENDING order in one conversation (orders_pending_dedup_idx, "race #3") —
 * correct for a customer who repeats themselves, but it made every
 * expectOrder case fail from run 2 on (the agent's create_order came back as
 * "re-read (duplicate turn)" and no new row appeared). Cancelling the pending
 * orders earlier runs wrote puts each run back in run 1's starting state.
 * Seeded fixture orders (`keepIds`) are never touched. Eval tenants only.
 */
export async function retireEvalPendingOrders(
  tenantContext: TenantContextService,
  tenantId: string,
  conversationId: string,
  keepIds: readonly string[],
): Promise<void> {
  await tenantContext.withTenantTx(
    (tx) =>
      tx
        .update(orders)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.conversationId, conversationId),
            eq(orders.status, 'pending_approval'),
            ...(keepIds.length ? [notInArray(orders.id, [...keepIds])] : []),
          ),
        ),
    tenantId,
  );
}

/**
 * L2's `expectOrder`/`expectNoOrder` verification: the newest order row on
 * this conversation that was NOT already there before the turn ran (the
 * `excludeOrderIds` a caller collects from `findExistingOrderIdsForConversation`
 * plus every prior turn in the same multi-turn case) — read straight from
 * `orders`/`order_items` via the same tenant-scoped transaction every service
 * uses, never from the tool's own JSON result (that would be checking the
 * agent's homework against itself).
 */
export async function findNewOrderForConversation(
  tenantContext: TenantContextService,
  tenantId: string,
  conversationId: string,
  excludeOrderIds: readonly string[],
): Promise<(ActualOrder & { id: string }) | null> {
  const rows = await tenantContext.withTenantTx(
    (tx) =>
      tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.conversationId, conversationId),
            ...(excludeOrderIds.length
              ? [notInArray(orders.id, [...excludeOrderIds])]
              : []),
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(1),
    tenantId,
  );
  const order = rows[0];
  if (!order) return null;

  const items = await tenantContext.withTenantTx(
    (tx) =>
      tx
        .select()
        .from(orderItems)
        .where(
          and(
            eq(orderItems.tenantId, tenantId),
            eq(orderItems.orderId, order.id),
          ),
        ),
    tenantId,
  );

  return {
    id: order.id,
    items: items.map((item) => ({
      productName: item.productName,
      sku: item.sku,
      quantity: item.quantity,
    })),
    total: order.total,
    currency: order.currency,
  };
}

async function disableTool(
  services: FixtureServices,
  tenantId: string,
  name: string,
): Promise<void> {
  if (name === 'create_order') {
    await services.orderToolSeeder.syncForMode(tenantId, 'disabled');
    return;
  }
  const definition = TOOL_DEFINITIONS[name];
  if (!definition) return;
  await services.toolRegistry.upsertTool(tenantId, {
    name: definition.name,
    description: definition.description,
    jsonSchema: definition.jsonSchema,
    enabled: false,
  });
}
