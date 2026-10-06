export const TRIAL_EMAIL_CHECK_QUEUE = 'trial-email-check';
export const TRIAL_EMAIL_CHECK_JOB_NAME = 'sweep';
/** Fixed BullMQ repeat-scheduler id — upsertJobScheduler keyed on this is idempotent across app restarts, same convention as AlertingModule's schedulers. */
export const TRIAL_EMAIL_CHECK_SCHEDULER_ID = 'trial-email-check-scheduler';
