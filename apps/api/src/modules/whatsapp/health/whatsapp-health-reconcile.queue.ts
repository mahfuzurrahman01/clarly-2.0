// Channel (WhatsappHealthModule, Gulf T5 / D5): the daily number-health
// reconcile queue.
export const WHATSAPP_HEALTH_RECONCILE_QUEUE = 'whatsapp-health-reconcile';
export const WHATSAPP_HEALTH_RECONCILE_JOB_NAME = 'sweep';
/** Fixed BullMQ repeat-scheduler id: `upsertJobScheduler` keyed on it is idempotent across restarts. Same pattern as META_TOKEN_REFRESH_SCHEDULER_ID. */
export const WHATSAPP_HEALTH_RECONCILE_SCHEDULER_ID =
  'whatsapp-health-reconcile-scheduler';
