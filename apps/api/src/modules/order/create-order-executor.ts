// F25 D4: MOVED from `store/create-order-executor.ts`, and rewritten.
//
// What changed, and why it is not a regression:
//
//   F24's version called `StoreProvider.createOrder()` SYNCHRONOUSLY, inside
//   the agent's bounded loop, and returned the provider's result — including a
//   `paymentUrl` — straight to the model. A Salla timeout therefore burned the
//   agent's loop deadline (T9's latency budget) and lost the order entirely,
//   because nothing had ever been persisted on our side.
//
//   This version makes no provider HTTP call at all. It writes Clarly's own
//   `orders` row (authoritative, D4) and, when the order is confirmed, leaves
//   an asynchronous job to reach the store. A store outage now delays a sync;
//   it cannot lose an order and cannot block the customer's reply.
//
// The other half of the rewrite is the GATE. F24 seeded `create_order` for no
// tenant deliberately; F25 owns the gate that makes it callable, and this
// executor is its second, independent half (D1.2): the write transaction
// re-reads `tenant_order_settings.mode` and refuses with `ToolScopeViolation`
// if it is `disabled` — a `tenant_tools` row is a cache of an authorization
// decision, not the decision itself.
import { Injectable } from '@nestjs/common';
import { LLMMalformedToolCall, ToolScopeViolation } from '@repo/errors';
import { AppLoggerService } from '../core';
import { StoreConnectionService } from '../store/store-connection.service';
import type { ToolExecutionContext } from '../tool-execution/tool-execution-context';
import type { CreateOrderInput } from './create-order.tool';
import {
  findMissingCustomerDetails,
  isAddressGroundedIn,
  type CustomerDetailField,
} from './customer-detail-placeholders';
import { OrderResolutionError } from './order-item-resolution';
import { OrderService } from './order.service';

/**
 * What the model gets back. Deliberately NOT the provider's payload:
 *
 *  - `customerMessage` is a MACHINE TOKEN, not prose. L0 maps it to wording in
 *    the customer's own dialect; putting the sentence here would hard-code one
 *    language into an executor.
 *  - `items` are as STORED — name, quantity and the catalogue unit price — so
 *    a model that was told a price by the customer cannot repeat it back as
 *    fact.
 *  - there is no `paymentUrl`. The store's own payment link is persisted
 *    (`orders.store_payment_url`) but never surfaced: with no payment webhook
 *    we could not answer the next question the customer asks (D3).
 */
export interface CreateOrderToolResult {
  status: 'pending_approval' | 'confirmed';
  orderReference: string;
  total: string;
  currency: string;
  items: Array<{ name: string; quantity: number; unitPrice: string }>;
  customerMessage:
    | 'not_yet_placed_awaiting_merchant_confirmation'
    | 'order_placed_cash_on_delivery';
  /** True when this call found an order an earlier attempt had already written; the agent must not confirm twice (D6.2). */
  duplicate: boolean;
}

/** A refusal the agent can act on, rather than a thrown error that burns the loop. */
export interface CreateOrderRefusal {
  status: 'refused';
  reason:
    | 'unknown_product'
    | 'inactive_product'
    | 'insufficient_stock'
    | 'mixed_currency'
    | 'variant_unavailable';
  message: string;
  /**
   * `lookup_product_then_retry` is for refusals the model caused (an id it did
   * not get from a lookup, the wrong variant row): it can fix them with a
   * lookup, so it is told to, instead of being sent straight to a human.
   */
  customerMessage:
    'cannot_place_order_escalate_to_team' | 'lookup_product_then_retry';
}

/**
 * The model filled a required contact field with filler ("Customer", "Not
 * provided yet") instead of asking. Returned as a structured result rather
 * than thrown as LLMMalformedToolCall: that error only triggers a blind
 * corrective retry, and the model would just re-invent a different filler.
 * This names the exact fields so the next thing it does is ASK the customer.
 */
export interface CreateOrderMissingDetails {
  status: 'refused';
  reason: 'missing_customer_details';
  missingFields: CustomerDetailField[];
  message: string;
  customerMessage: 'ask_customer_for_missing_details';
}

/** Refusals the model can fix itself (with a lookup) versus ones only the team can. */
const RECOVERABLE_FAILURES: ReadonlySet<OrderResolutionError['failure']> =
  new Set(['unknown_product', 'variant_unavailable']);

const UNKNOWN_PRODUCT_RECOVERY =
  'No order was created. This productId did not come from a lookup_product result for this shop. Call lookup_product for what the customer wants, take the id from the row that matches, then call create_order again. Never invent, guess or reuse an id from anywhere else.';

const VARIANT_RECOVERY =
  'Use lookup_product to find the row for the variant the customer named; never order a different row instead.';

function refusalFor(error: OrderResolutionError): CreateOrderRefusal {
  if (!RECOVERABLE_FAILURES.has(error.failure)) {
    return {
      status: 'refused',
      reason: error.failure,
      message: error.message,
      customerMessage: 'cannot_place_order_escalate_to_team',
    };
  }
  return {
    status: 'refused',
    reason: error.failure,
    message:
      error.failure === 'unknown_product'
        ? UNKNOWN_PRODUCT_RECOVERY
        : `No order was created. ${error.message} ${VARIANT_RECOVERY}`,
    customerMessage: 'lookup_product_then_retry',
  };
}

@Injectable()
export class CreateOrderExecutor {
  constructor(
    private readonly orders: OrderService,
    private readonly connections: StoreConnectionService,
    private readonly logger: AppLoggerService,
  ) {}

  async execute(
    ctx: ToolExecutionContext,
    args: CreateOrderInput,
  ): Promise<
    CreateOrderToolResult | CreateOrderRefusal | CreateOrderMissingDetails
  > {
    // A tool that writes a row against a customer cannot run without one.
    // `CommentReplyAgent` drafts a reply where no conversation and no customer
    // exist yet; an order for a null customer is not a thing, and inventing a
    // placeholder id would be inventing an identity.
    if (!ctx.customerId) {
      throw new ToolScopeViolation();
    }

    // Belt-and-braces over `authorize()`: an executor reached with unparsed
    // args is the path an attacker-shaped payload would arrive on.
    if (!Array.isArray(args.items) || args.items.length === 0) {
      throw new LLMMalformedToolCall();
    }

    // No order is written on filler contact details (bar: zero wrong orders).
    const missingFields = findMissingCustomerDetails(args);
    if (
      ctx.customerText !== undefined &&
      !missingFields.includes('shippingAddress') &&
      !isAddressGroundedIn(args.shippingAddress, ctx.customerText)
    ) {
      missingFields.push('shippingAddress');
    }
    if (missingFields.length > 0) {
      return {
        status: 'refused',
        reason: 'missing_customer_details',
        missingFields,
        message: `No order was created. The value(s) for ${missingFields.join(', ')} are missing or placeholders. Ask the customer for exactly these details (name, phone number, delivery address as applicable), then call create_order again with the values they give. Never invent, guess or use filler values.`,
        customerMessage: 'ask_customer_for_missing_details',
      };
    }

    // Resolved ONCE, before the write, and pinned onto the row (D4.4). F24
    // re-chose the connection at call time from an unordered query, so a
    // tenant with two stores could send the same order to a different one on
    // each run.
    const connection = (
      await this.connections.findActiveByTenant(ctx.tenantId)
    )[0];

    try {
      const result = await this.orders.createFromTurn({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        customerId: ctx.customerId,
        turnId: ctx.turnId,
        contactName: args.customerName,
        contactPhone: args.customerPhone,
        address: args.shippingAddress,
        city: args.city ?? null,
        notes: args.notes ?? null,
        items: args.items,
        storeConnectionId: connection?.id ?? null,
        storeProvider: connection?.provider ?? null,
      });

      const status = result.order.status as 'pending_approval' | 'confirmed';

      this.logger.log(
        `Order ${result.order.reference} ${result.duplicate ? 're-read (duplicate turn)' : 'created'} for tenant ${ctx.tenantId} in status ${status}`,
        'CreateOrderExecutor',
      );

      return {
        status,
        orderReference: result.order.reference,
        total: result.order.total,
        currency: result.order.currency,
        items: result.items.map((item) => ({
          name: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        customerMessage:
          status === 'confirmed'
            ? 'order_placed_cash_on_delivery'
            : 'not_yet_placed_awaiting_merchant_confirmation',
        duplicate: result.duplicate,
      };
    } catch (error) {
      // A catalogue problem is an answer for the agent, not a loop failure:
      // the customer asked for something we cannot sell them right now, and
      // the agent should say so and escalate rather than retry.
      if (error instanceof OrderResolutionError) {
        return refusalFor(error);
      }
      // ToolScopeViolation (the mode gate) and everything else keep their
      // existing meaning and their existing escalation path.
      throw error;
    }
  }
}
