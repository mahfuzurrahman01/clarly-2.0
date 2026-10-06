export const PLATFORM_HEALTH_CHECK_QUEUE = 'platform-health-check';
export const PLATFORM_HEALTH_CHECK_JOB_NAME = 'sweep';
/** Fixed BullMQ repeat-scheduler id — `upsertJobScheduler` keyed on this is idempotent across app restarts, never accumulating duplicate repeat schedules. */
export const PLATFORM_HEALTH_CHECK_SCHEDULER_ID =
  'platform-health-check-scheduler';
