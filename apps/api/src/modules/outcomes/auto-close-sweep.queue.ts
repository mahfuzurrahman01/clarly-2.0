export const AUTO_CLOSE_SWEEP_QUEUE = 'auto-close-sweep';
export const AUTO_CLOSE_SWEEP_JOB_NAME = 'sweep';
/** Fixed BullMQ repeat-scheduler id — upsertJobScheduler keyed on this is idempotent across app restarts, never accumulating duplicate repeat schedules. */
export const AUTO_CLOSE_SWEEP_SCHEDULER_ID = 'auto-close-sweep-scheduler';
