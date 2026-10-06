// F26 (Delivery Tracking): queue/job/scheduler ids for the poll sweep (D5).
//
// Two job NAMES on one queue, deliberately:
//   - `sweep` is the repeatable platform-wide scan, registered once via
//     `upsertJobScheduler` (never `setInterval`, which fans out once per
//     replica — F24's store sync did exactly that).
//   - `refresh` is the targeted "this shipment's stored state is stale"
//     job `track_order` enqueues. Same worker, same connection batching,
//     same breaker; only the selection differs.
export const SHIPMENT_POLL_QUEUE = 'shipment-poll';
export const SHIPMENT_POLL_SWEEP_JOB = 'sweep';
export const SHIPMENT_POLL_REFRESH_JOB = 'refresh';
/** Fixed BullMQ repeat-scheduler id — `upsertJobScheduler` keyed on this is idempotent across restarts and replicas. */
export const SHIPMENT_POLL_SCHEDULER_ID = 'shipment-poll-scheduler';

/**
 * How many shipments one sweep pass polls for ONE tenant. The sweep enters
 * each tenant in turn (FORCE RLS), so the bound is per tenant: one merchant
 * with a huge backlog cannot starve the others; the rest wait for the next
 * pass.
 */
export const SHIPMENT_POLL_BATCH_LIMIT = 200;

export interface ShipmentRefreshJobData {
  /** The tenant the shipments belong to — required: they are read under `withTenantTx`. */
  tenantId: string;
  shipmentIds: string[];
}
