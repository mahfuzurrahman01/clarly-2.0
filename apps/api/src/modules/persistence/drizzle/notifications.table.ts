// Product shell (NotificationsModule, T4/T18): durable, tenant-visible
// alerts.
//
// AlertingModule has fired structured alerts since Feature 7 and nobody has
// ever received one — four event services, zero subscribers. A log line is
// a signal for US; a tenant whose ticket sat unclaimed all night has no way
// to find out it happened. This table is where an alert stops being
// ephemeral.
//
// Platform-health alerts are deliberately NOT stored here: they carry no
// tenantId because they are about our infrastructure (breaker open, DLQ
// depth), and showing a tenant our queue depth would be both meaningless
// and a leak. They stay on the operator log path.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
  jsonb,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const NOTIFICATION_KINDS = [
  'ticket_stuck',
  'latency_budget_exceeded',
  'tool_scope_violations',
  // Launch billing backend (Lane A): TrialEmailService's two sweeps. Both
  // tenant-scoped (unlike the platform-health kinds this file's own
  // header comment calls out), so they belong here, not on the operator
  // log path.
  'trial_ending',
  'trial_expired',
  // Dunning email: payment failure notification for past-due tenants.
  'payment_failed',
  // F19 (D3/D10): a campaign send paused itself (spend cap, tier limit,
  // template revoked). Not wired into a live send pipeline yet — the sender
  // is out of scope for the first F19 slice — but added now so the kind
  // exists the moment CampaignSendProcessor lands rather than as a second
  // migration.
  'campaign_paused',
  // F25 (D10.6): the three order kinds. `kind` is free text in the column, so
  // no migration is needed — this list is the application-side contract the
  // notifications DTO validates against.
  'order_pending_approval',
  'order_store_push_failed',
  'order_auto_mode_review',
  // F26 (D8): the two merchant-facing courier problems. A connection whose
  // credentials the courier keeps rejecting, and a status whose mapped
  // template cannot be sent — both are things only the merchant can fix, and
  // both would otherwise be silent staleness.
  'courier_connection_failing',
  'shipment_template_unusable',
  // Clarly 2.0 S2 (bookings): a customer asked for an appointment a person
  // must confirm, and the connected calendar stopped accepting our grant.
  'booking_requested',
  'calendar_needs_reconnect',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ['warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    /** One line, already written for a human — the console renders it as-is rather than re-deriving wording per kind. */
    title: text('title').notNull(),
    body: text('body').notNull(),
    /**
     * QA 2026-10-05: the values interpolated into `title`/`body`, keyed per
     * `kind` (see notifications/notification-content.ts), so the console can
     * render the notification in the operator's language. `title`/`body` stay
     * the English fallback. Null on rows written before migration 0068.
     */
    params: jsonb('params').$type<Record<string, string | number>>(),
    /** What this is about, so the console can deep-link (currently only 'ticket'). Null for tenant-wide conditions. */
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    /**
     * What makes this notification the same event as another.
     *
     * Load-bearing, not an optimisation. The stuck-ticket sweep re-evaluates
     * every unclaimed ticket on every run and fires an alert each time — one
     * ticket left overnight would otherwise produce a notification every few
     * minutes until morning, which is how a notification list becomes noise
     * a human learns to ignore. Unique per tenant, written with
     * ON CONFLICT DO NOTHING, so "this ticket went unclaimed" is one
     * notification no matter how many times the condition is observed.
     */
    dedupKey: text('dedup_key').notNull(),
    /** Null until someone reads it. */
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.tenantId, table.dedupKey)],
).enableRLS();
