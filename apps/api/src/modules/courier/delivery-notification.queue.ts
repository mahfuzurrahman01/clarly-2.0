// F26 (Delivery Tracking): the proactive-notification send queue (D5).
//
// Sends are enqueued rather than performed inline in the poll processor, for
// two reasons the spec states: one slow BSP call must not stall a sweep, and
// a failed send must retry with the claim row already held — so a retry can
// never double-send a send that actually succeeded.
export const DELIVERY_NOTIFICATION_QUEUE = 'delivery-notification';
export const DELIVERY_NOTIFICATION_JOB = 'notify';

/** Bounded: a BSP rejection that is not transient (revoked template) must stop, not retry forever. */
export const DELIVERY_NOTIFICATION_ATTEMPTS = 3;

export interface DeliveryNotificationJobData {
  tenantId: string;
  shipmentId: string;
  status: string;
}
