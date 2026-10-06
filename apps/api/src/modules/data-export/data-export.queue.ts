// Assembling an export reads every row a tenant owns, so it runs on a queue
// rather than in the request. Its own queue, not the purge one: an export is
// tenant-triggered and bursty where the purges are scheduled housekeeping, and
// a slow export must never delay an erasure that was promised a date.
export const DATA_EXPORT_QUEUE = 'data-export';
export const DATA_EXPORT_JOB_NAME = 'assemble-export';

/** The sweep that deletes expired bundles. Shares the queue because it is the same subsystem and neither job is hot. */
export const DATA_EXPORT_EXPIRY_JOB_NAME = 'purge-expired-exports';
export const DATA_EXPORT_EXPIRY_SCHEDULER_ID = 'data-export-expiry-scheduler';
