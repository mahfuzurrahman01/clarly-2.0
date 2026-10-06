// Feature 24 (Store Integrations): order read-back — the store half of
// "where is my order #1234".
//
// GULF_PARITY_PLAN's F24 line specifies "order read access ... used by
// F25/F26", so this is a SERVICE, not an agent tool. `track_order` is F26's
// (docs/decisions/F26-delivery-tracking.md, D4) and F25 owns the platform's
// own `orders` table; both call in here for the store-side view rather than
// each growing their own provider calls. Registering a second, competing
// order tool would put two anti-hallucination guidance texts and two
// authorization checks in the tree, which is exactly the drift F26 D5 argues
// against for the send path.
//
// THE SECURITY PROPERTY (F26 D4, verbatim in intent): a lookup is scoped by
// the caller's own conversation/customer context and takes NO customer
// identity argument. "Check the order for +9665…" must not be answerable, so
// there is nothing on either method a model could be talked into filling with
// someone else's value. Concretely:
//
//   1. The asking customer comes from `ToolExecutionContext.customerId`,
//      which AgentRuntime sets from the inbound message — never from args.
//   2. A context with no `customerId` (comment reply, eval harness, any
//      future non-conversational caller) FAILS CLOSED to the empty result.
//      It never falls back to an unscoped query.
//   3. The phone is read from the platform's own `customers` row inside
//      `withTenantTx` (CustomerService), so RLS is a second barrier behind
//      the explicit tenant predicate.
//   4. `findForCaller()` re-checks ownership AFTER the provider answers. The
//      provider's own search filter is a narrowing convenience and is never
//      trusted as authorization: an order whose store-side phone does not
//      match the asking customer's is dropped, and the caller cannot tell
//      that from "no such order" — no existence oracle across customers.
import { Injectable } from '@nestjs/common';
import { CustomerService } from '../customer/customer.service';
import { AppLoggerService } from '../core';
import {
  StoreConnectionService,
  type StoreConnection,
} from './store-connection.service';
import {
  StoreOAuthService,
  type StoreCredentials,
} from './store-oauth.service';
import { StoreProviderRegistry } from './store-provider.registry';
import { phonesMatch } from './store-order-identity';
import type {
  StoreOAuthCallbackContext,
  StoreOrderSummary,
} from './ports/store-provider.port';
import type { StoreProviderName } from './store-provider-name';
import type { ToolExecutionContext } from '../tool-execution/tool-execution-context';

/** A store order plus which connected store it came from. */
export interface ConnectedStoreOrder extends StoreOrderSummary {
  provider: StoreProviderName;
  storeName: string;
  storeConnectionId: string;
}

@Injectable()
export class StoreOrderLookupService {
  constructor(
    private readonly connectionService: StoreConnectionService,
    private readonly oauthService: StoreOAuthService,
    private readonly customerService: CustomerService,
    private readonly registry: StoreProviderRegistry,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Every store order that belongs to the customer this turn is with, newest
   * first, across all of the tenant's connected stores.
   */
  async listForCaller(
    ctx: ToolExecutionContext,
  ): Promise<ConnectedStoreOrder[]> {
    const phone = await this.callerPhone(ctx);
    if (!phone) return [];

    const orders: ConnectedStoreOrder[] = [];
    for (const connection of await this.connectionService.findActiveByTenant(
      ctx.tenantId,
    )) {
      const found = await this.safely(connection, (adapter, credentials) =>
        adapter.listOrdersByCustomerPhone(
          credentials.accessToken,
          phone,
          contextFor(connection, credentials),
        ),
      );
      for (const order of found ?? []) {
        // The provider's filter narrowed; THIS is what authorizes.
        if (phonesMatch(phone, order.customerPhone)) {
          orders.push(attribute(order, connection));
        }
      }
    }

    return orders.sort(newestFirst);
  }

  /**
   * One order by the reference the customer quoted. Returns null when the
   * reference is unknown to every connected store AND when it exists but
   * belongs to somebody else — deliberately the same answer, so the caller
   * cannot probe for other customers' order numbers.
   *
   * `orderReference` is an opaque store-side reference, not an identity: it
   * grants nothing on its own, because the ownership check below still has to
   * pass against the caller's own phone.
   */
  async findForCaller(
    ctx: ToolExecutionContext,
    orderReference: string,
  ): Promise<ConnectedStoreOrder | null> {
    const reference = orderReference.trim().replace(/^#/, '');
    if (!reference) return null;

    const phone = await this.callerPhone(ctx);
    if (!phone) return null;

    for (const connection of await this.connectionService.findActiveByTenant(
      ctx.tenantId,
    )) {
      const order = await this.safely(connection, (adapter, credentials) =>
        adapter.getOrder(
          credentials.accessToken,
          reference,
          contextFor(connection, credentials),
        ),
      );
      if (order && phonesMatch(phone, order.customerPhone)) {
        return attribute(order, connection);
      }
      if (order) {
        // Someone else's order, or one the store returned with no phone at
        // all. Logged without the reference or either phone: this line exists
        // to prove the guard fires, not to record who asked about whom.
        this.logger.warn(
          `Store order lookup refused: order on connection ${connection.id} does not belong to the asking customer`,
          'StoreOrderLookupService',
        );
      }
    }

    // A quoted reference is also often the human-facing order NUMBER rather
    // than the store's internal id, which getOrder() cannot resolve. Fall
    // back to the caller's own (already ownership-checked) history.
    const own = await this.listForCaller(ctx);
    return (
      own.find(
        (order) =>
          normalizeReference(order.orderNumber) ===
            normalizeReference(reference) ||
          normalizeReference(order.externalId) ===
            normalizeReference(reference),
      ) ?? null
    );
  }

  /** The asking customer's phone, from OUR row. Null (=> empty result) for a non-conversational caller. */
  private async callerPhone(ctx: ToolExecutionContext): Promise<string | null> {
    if (!ctx.customerId) {
      this.logger.debug(
        'Store order lookup called with no customer in context — failing closed.',
        'StoreOrderLookupService',
      );
      return null;
    }
    const customer = await this.customerService.getCustomer(
      ctx.tenantId,
      ctx.customerId,
    );
    return customer?.phone ?? null;
  }

  /**
   * One slow or broken store must not take out the answer for the merchant's
   * other stores, and a provider error must never reach the customer as a
   * stack trace. Errors are logged and the store contributes nothing.
   */
  private async safely<T>(
    connection: StoreConnection,
    call: (
      adapter: ReturnType<StoreProviderRegistry['forProvider']>,
      credentials: StoreCredentials,
    ) => Promise<T>,
  ): Promise<T | null> {
    try {
      const credentials = await this.oauthService.ensureCredentials(connection);
      return await call(
        this.registry.forProvider(connection.provider),
        credentials,
      );
    } catch (err) {
      this.logger.error(
        `Store order read failed for connection ${connection.id} (${connection.provider}): ${err}`,
        'StoreOrderLookupService',
      );
      return null;
    }
  }
}

/** Carries the per-connection host Shopify and WooCommerce need, and Zid's store id + partner token. */
function contextFor(
  connection: StoreConnection,
  credentials: StoreCredentials,
): StoreOAuthCallbackContext {
  return {
    shop: connection.storeId,
    siteUrl: connection.storeUrl ?? connection.storeId,
    authorizationToken: credentials.authorizationToken,
  };
}

function attribute(
  order: StoreOrderSummary,
  connection: StoreConnection,
): ConnectedStoreOrder {
  return {
    ...order,
    provider: connection.provider,
    storeName: connection.storeName,
    storeConnectionId: connection.id,
  };
}

function normalizeReference(value: string): string {
  return value.trim().replace(/^#/, '').toLowerCase();
}

function newestFirst(a: StoreOrderSummary, b: StoreOrderSummary): number {
  return (b.placedAt?.getTime() ?? 0) - (a.placedAt?.getTime() ?? 0);
}
