// Feature 24 (Store Integrations): queue/job/scheduler ids for the store
// product-sync sweep.
//
// One repeatable job, `sweep`, registered once via `upsertJobScheduler`
// (never `setInterval`, which fans out once per replica — job rows for the
// same connection would duplicate per replica, the exact gap
// GULF_PARITY_PLAN.md called out). Same idiom as F26's
// `shipment-poll.queue.ts`.
export const STORE_SYNC_QUEUE = 'store-sync';
export const STORE_SYNC_SWEEP_JOB = 'sweep';
/** Fixed BullMQ repeat-scheduler id — `upsertJobScheduler` keyed on this is idempotent across restarts and replicas. */
export const STORE_SYNC_SCHEDULER_ID = 'store-sync-scheduler';
