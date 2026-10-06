// The scheduled sweep that erases closed tenants once their grace period has
// run out. Separate from T16's transcript purge: that one trims old
// conversations out of live tenants, this one removes whole tenants that asked
// to leave. Different cadence, different blast radius, so a failure in one
// must never stall the other.
export const TENANT_PURGE_QUEUE = 'tenant-purge';
export const TENANT_PURGE_JOB_NAME = 'purge-due-tenants';
export const TENANT_PURGE_SCHEDULER_ID = 'tenant-purge-scheduler';
