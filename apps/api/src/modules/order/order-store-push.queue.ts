// F25 D4: the asynchronous, at-most-once push of a confirmed order to the
// tenant's connected store.
//
// `jobId` is the ORDER ID, so the queue itself dedupes enqueues (race #5's
// first line of defence — the processor's `FOR UPDATE` re-check of
// `store_sync_status` is the second, and the unique index on
// `(tenant_id, store_connection_id, external_order_id)` is the third).
export const ORDER_STORE_PUSH_QUEUE = 'order-store-push';
export const ORDER_STORE_PUSH_JOB_NAME = 'push';

/** D4.6: bounded retries. After these, `store_sync_status='failed'` and a notification — the ORDER stays `confirmed`. */
export const ORDER_STORE_PUSH_ATTEMPTS = 5;

export interface OrderStorePushJobData {
  tenantId: string;
  orderId: string;
}

/** BullMQ dedupes on this; one order can only ever have one push job in flight. */
export function orderStorePushJobId(orderId: string): string {
  return `order-store-push:${orderId}`;
}
