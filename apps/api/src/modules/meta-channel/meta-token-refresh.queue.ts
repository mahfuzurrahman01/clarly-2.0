export const META_TOKEN_REFRESH_QUEUE = 'meta-token-refresh';
export const META_TOKEN_REFRESH_JOB_NAME = 'sweep';
/** Fixed BullMQ repeat-scheduler id — `upsertJobScheduler` keyed on this is idempotent across restarts and never accumulates duplicate schedules. Same pattern as TRANSCRIPT_PURGE_SCHEDULER_ID. */
export const META_TOKEN_REFRESH_SCHEDULER_ID = 'meta-token-refresh-scheduler';
