export const LATENCY_BUDGET_CHECK_QUEUE = 'latency-budget-check';
export const LATENCY_BUDGET_CHECK_JOB_NAME = 'sweep';
/** Fixed BullMQ repeat-scheduler id — upsertJobScheduler keyed on this is idempotent across app restarts, never accumulating duplicate repeat schedules. */
export const LATENCY_BUDGET_CHECK_SCHEDULER_ID =
  'latency-budget-check-scheduler';
