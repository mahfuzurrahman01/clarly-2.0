export const TRANSCRIPT_PURGE_QUEUE = 'transcript-purge';
export const TRANSCRIPT_PURGE_JOB_NAME = 'sweep';
/** Fixed BullMQ repeat-scheduler id — upsertJobScheduler keyed on this is idempotent across app restarts, never accumulating duplicate repeat schedules. */
export const TRANSCRIPT_PURGE_SCHEDULER_ID = 'transcript-purge-scheduler';
