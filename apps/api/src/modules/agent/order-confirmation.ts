// A deterministic confirmation for an order the agent already WROTE.
//
// Why this exists (cycle 3 eval, 2026-09-30): create_order is a side effect.
// When the loop deadline is missed after it succeeded, the turn used to
// escalate LLM_ERROR with the generic hand-off line, so the customer never
// heard that an order existed (4 cases, plus 3 commerce-roundtrip-cap turns)
// and was invited to place it again. The wording here is built only from the
// created order row (reference, items, quantities, total) that create_order
// returned, so it needs no model call and no grounding check: nothing in it
// can be invented.
//
// Language: the runtime knows the customer's message, not a locale. Arabic
// script in the message selects the Arabic template; everything else gets
// English. That is the same coarse split the eval corpora use, and a wrong
// guess still leaves a correct, readable confirmation with the reference.
//
// Wording follows create_order's own contract: a `pending_approval` order is
// "recorded, the team will confirm" and is never called placed, paid or
// shipped; only `confirmed` may say "placed". Payment is cash on delivery.
import { z } from 'zod';

const CreatedOrderSchema = z.object({
  status: z.enum(['pending_approval', 'confirmed']),
  orderReference: z.string().min(1),
  total: z.string().min(1).optional(),
  currency: z.string().min(1).optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPrice: z.string().min(1).optional(),
      }),
    )
    .optional(),
});

/** An order row as create_order reported it. Only the fields the confirmation prints. */
export type CreatedOrder = z.infer<typeof CreatedOrderSchema>;

const ARABIC_SCRIPT = /[؀-ۿ]/;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Every order that a create_order call wrote (or re-read as a duplicate of an
 * earlier attempt) this turn, one per distinct reference, in call order. A
 * refusal, a track_order result and any other tool output do not match: the
 * schema needs a top-level `orderReference` and a `pending_approval` or
 * `confirmed` status, which only a successful create_order result carries.
 */
export function findCreatedOrders(toolEvidence: string[]): CreatedOrder[] {
  const byReference = new Map<string, CreatedOrder>();
  for (const evidence of toolEvidence) {
    const parsed = CreatedOrderSchema.safeParse(parseJson(evidence));
    if (parsed.success && !byReference.has(parsed.data.orderReference)) {
      byReference.set(parsed.data.orderReference, parsed.data);
    }
  }
  return [...byReference.values()];
}

interface Wording {
  recorded: (reference: string) => string;
  placed: (reference: string) => string;
  total: (amount: string) => string;
  closingPending: string;
}

const ENGLISH: Wording = {
  recorded: (reference) =>
    `Your order ${reference} has been recorded and is waiting for our team to confirm it.`,
  placed: (reference) => `Your order ${reference} is placed.`,
  total: (amount) => `Total: ${amount}, cash on delivery.`,
  closingPending: 'We will message you as soon as it is confirmed.',
};

const ARABIC: Wording = {
  recorded: (reference) =>
    `تم تسجيل طلبك رقم ${reference} وهو بانتظار تأكيد فريقنا.`,
  placed: (reference) => `تم تقديم طلبك رقم ${reference}.`,
  total: (amount) => `الإجمالي: ${amount}، الدفع عند الاستلام.`,
  closingPending: 'سنراسلك فور تأكيده.',
};

function withCurrency(amount: string, currency: string | undefined): string {
  return currency ? `${amount} ${currency}` : amount;
}

function describeItem(
  item: NonNullable<CreatedOrder['items']>[number],
  currency: string | undefined,
): string {
  const price = item.unitPrice
    ? ` (${withCurrency(item.unitPrice, currency)})`
    : '';
  return `- ${item.quantity} × ${item.name}${price}`;
}

function describeOrder(order: CreatedOrder, wording: Wording): string {
  const pending = order.status === 'pending_approval';
  const lines = [
    pending
      ? wording.recorded(order.orderReference)
      : wording.placed(order.orderReference),
    ...(order.items ?? []).map((item) => describeItem(item, order.currency)),
    ...(order.total
      ? [wording.total(withCurrency(order.total, order.currency))]
      : []),
    ...(pending ? [wording.closingPending] : []),
  ];
  return lines.join('\n');
}

/**
 * The customer-facing confirmation for the orders in `toolEvidence`, or `null`
 * when this turn wrote none (the caller then keeps its normal escalation).
 */
export function buildOrderConfirmation(
  toolEvidence: string[],
  customerMessage: string,
): string | null {
  const orders = findCreatedOrders(toolEvidence);
  if (orders.length === 0) return null;
  const wording = ARABIC_SCRIPT.test(customerMessage) ? ARABIC : ENGLISH;
  return orders.map((order) => describeOrder(order, wording)).join('\n\n');
}
