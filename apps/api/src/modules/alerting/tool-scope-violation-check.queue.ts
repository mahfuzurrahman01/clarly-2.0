export const TOOL_SCOPE_VIOLATION_CHECK_QUEUE = 'tool-scope-violation-check';
export const TOOL_SCOPE_VIOLATION_CHECK_JOB_NAME = 'sweep';
/** Fixed BullMQ repeat-scheduler id — `upsertJobScheduler` keyed on this is idempotent across app restarts, never accumulating duplicate repeat schedules. */
export const TOOL_SCOPE_VIOLATION_CHECK_SCHEDULER_ID =
  'tool-scope-violation-check-scheduler';
