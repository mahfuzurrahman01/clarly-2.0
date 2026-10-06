// Platform (PersistenceModule): Drizzle schema root. Every table lands in
// its own `*.table.ts` file under this directory (many-small-files per
// CLAUDE.md) and is re-exported below — this file stays a barrel, not a
// growing pile of table definitions.
export * from './tenants.table';
export * from './tenant-tools.table';
export * from './whatsapp-numbers.table';
export * from './social-channels.table';
export * from './webhook-message-dedup.table';
export * from './tickets.table';
export * from './tenant-policy.table';
export * from './kb-documents.table';
export * from './conversations.table';
export * from './messages.table';
export * from './customers.table';
export * from './customer-labels.table';
export * from './agent-runs.table';
export * from './conversation-outcomes.table';
export * from './plans.table';
export * from './tenant-subscriptions.table';
export * from './stripe-customer-tenant-map.table';
export * from './agents.table';
export * from './agent-versions.table';
export * from './notifications.table';
export * from './agent-kb-documents.table';
export * from './answer-feedback.table';
export * from './intake.table';
export * from './tenant-webhooks.table';
export * from './message-templates.table';
export * from './audit-log.table';
export * from './data-exports.table';
export * from './meta-data-deletion-requests.table';
export * from './comment-events.table';
export * from './comment-actions.table';
export * from './comment-automation-rules.table';
export * from './products.table';
export * from './store-connections.table';
export * from './store-webhook-events.table';
export * from './store-sync-jobs.table';
export * from './segments.table';
export * from './campaigns.table';
export * from './campaign-recipients.table';
export * from './tenant-order-settings.table';
export * from './orders.table';
export * from './order-items.table';
export * from './courier-connections.table';
export * from './shipments.table';
export * from './shipment-status-events.table';
export * from './shipment-notifications.table';
export * from './delivery-notification-settings.table';
export * from './courier-webhook-events.table';
export * from './platform-admins.table';
// Clarly 2.0 S2 — bookings (migration 0071)
export * from './tenant-booking-settings.table';
export * from './booking-services.table';
export * from './calendar-connections.table';
export * from './bookings.table';
// Clarly 2.0 S3 — website widget (migration 0072)
export * from './web-widgets.table';
export * from './connection-routes.table';
export * from './messaging.table';
