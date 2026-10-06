// F25 D2.1: the order status lifecycle, as a pure function in its own file so
// it is exhaustively unit-testable with no DB — the same way
// `escalation-decision.ts` and `customer-label-derivation.ts` are.
//
//                       (auto mode)
// create_order ─────────────────────────────────► confirmed ──► fulfilled
//      │                                            │  ▲
//      │ (human_approval mode)                      │  │
//      └──► pending_approval ──approve──────────────┘  │
//                 │  │                                 │
//                 │  └──reject──► rejected             └──cancel──► cancelled
//                 └──sweep──────► expired
//                                              (bounded push failures) ──► failed
//
// Every transition in the services is a CONDITIONAL UPDATE guarded on the
// current status; this map is what decides which guard to write, and what a
// caller is told when the guard matches zero rows.
import type { OrderStatus } from '../persistence/drizzle/orders.table';

/** Statuses from which nothing further is allowed. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  'rejected',
  'expired',
  'cancelled',
  'fulfilled',
  'failed',
] as const;

const ALLOWED_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  pending_approval: ['confirmed', 'rejected', 'expired'],
  // `failed` is reachable from `confirmed` only through the store-push
  // processor exhausting its bounded retries — never from a console action.
  confirmed: ['fulfilled', 'cancelled', 'failed'],
  rejected: [],
  expired: [],
  cancelled: [],
  fulfilled: [],
  failed: [],
};

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function allowedTransitionsFrom(
  status: OrderStatus,
): readonly OrderStatus[] {
  return ALLOWED_TRANSITIONS[status] ?? [];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return allowedTransitionsFrom(from).includes(to);
}

/**
 * Thrown by the approval service when a conditional UPDATE matched zero rows
 * and the row's real status turns out to disallow the transition. A plain
 * domain error, not an HttpException — the same split KanbanModule already
 * draws with `InvalidTicketTransitionError`, mapped to 409 by
 * `InvalidOrderTransitionFilter`.
 */
export class InvalidOrderTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(
      `An order in status "${from}" cannot transition to "${to}". Allowed from here: ${
        allowedTransitionsFrom(from).join(', ') || '(none — terminal)'
      }.`,
    );
    this.name = 'InvalidOrderTransitionError';
  }
}
