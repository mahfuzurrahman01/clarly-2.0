// F25 D1.4: the approval-window sweep.
//
// Reuses the existing scheduled-sweep shape (the stuck-ticket check, which
// reads `tenant_policy.stuck_ticket_threshold_minutes` the same way this reads
// `tenant_order_settings.approval_window_hours`) — the same cron-style
// processor and `upsertJobScheduler` id, not a new scheduling mechanism.
//
// Phase 1 reserves no stock (D2.4), so an expired order costs nothing but a
// stale row. Expiry exists so the console queue does not accumulate zombies,
// and so a customer is never confirmed three days later.
export const ORDER_EXPIRY_QUEUE = 'order-expiry';
export const ORDER_EXPIRY_JOB_NAME = 'sweep';
/** Fixed BullMQ repeat-scheduler id — `upsertJobScheduler` keyed on this is idempotent across app restarts. */
export const ORDER_EXPIRY_SCHEDULER_ID = 'order-expiry-scheduler';
/** Hourly: the shortest configurable approval window is 1 hour, so a finer cadence would buy nothing. */
export const ORDER_EXPIRY_INTERVAL_MS = 60 * 60 * 1000;
