export const STUCK_TICKET_CHECK_QUEUE = 'stuck-ticket-check';
export const STUCK_TICKET_CHECK_JOB_NAME = 'sweep';
/** Fixed BullMQ repeat-scheduler id — `upsertJobScheduler` keyed on this is idempotent across app restarts, never accumulating duplicate repeat schedules. */
export const STUCK_TICKET_CHECK_SCHEDULER_ID = 'stuck-ticket-check-scheduler';
