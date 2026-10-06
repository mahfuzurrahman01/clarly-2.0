// F19 (D2): a campaign authors a send against ONE approved template, on ONE
// connected number, to the snapshot of ONE segment. See
// docs/decisions/F19-campaigns-broadcast.md.
//
// `status` is `text` + a CHECK constraint (migration 0055), matching every
// other status-vocabulary column in this codebase (`comment_events.status`,
// `campaign_recipients.status` below) rather than a Postgres `CREATE TYPE`
// enum — this repo does not use DB enums anywhere else, and a text CHECK is
// exactly as safe while staying consistent.
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  numeric,
  timestamp,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { segments } from './segments.table';
import { messageTemplates } from './message-templates.table';

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'paused_spend_cap',
  'paused_template',
  /** D8's `POST /campaigns/:id/pause` — a merchant stopped it (migration 0061). */
  'paused_manual',
  /** A revocable D4 block (messaging health, quality, verification, billing) appeared mid-send (migration 0061). */
  'paused_eligibility',
  'completed',
  'canceled',
  'failed',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** One element of `template_values` — a closed whitelist, no expressions, no arbitrary column access (D2). */
export type CampaignTemplateValue =
  | { type: 'literal'; value: string }
  | { type: 'customer_field'; field: 'name' | 'phone'; fallback: string };

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    segmentId: uuid('segment_id').notNull(),
    templateId: uuid('template_id').notNull(),
    /** Positional `{{n}}` fillers, rendered with the same `renderTemplateBody()` the console template send uses. */
    templateValues: jsonb('template_values')
      .notNull()
      .default('[]')
      .$type<CampaignTemplateValue[]>(),
    /** Which connected number sends. Explicit, never inferred — a tenant with two numbers on two WABAs has two different template-approval sets and tier allowances. */
    phoneNumberId: text('phone_number_id').notNull(),
    status: text('status').notNull().default('draft').$type<CampaignStatus>(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Set once, at snapshot time (SegmentResolver.snapshot) — never re-derived. */
    recipientCount: integer('recipient_count').notNull().default(0),
    estimatedCostUsd: numeric('estimated_cost_usd', {
      precision: 10,
      scale: 2,
      mode: 'number',
    })
      .notNull()
      .default(0),
    spendCapUsd: numeric('spend_cap_usd', {
      precision: 10,
      scale: 2,
      mode: 'number',
    }).notNull(),
    /** Incremented in the same transaction that marks a recipient `sent` — see D3. Higher precision than the cap: fractional-cent per-message rates accumulate. */
    spentUsd: numeric('spent_usd', { precision: 10, scale: 4, mode: 'number' })
      .notNull()
      .default(0),
    pauseReason: text('pause_reason'),
    failureReason: text('failure_reason'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('campaigns_tenant_id_id_unique').on(table.tenantId, table.id),
    // COMPOSITE FKs, on purpose (see customer-labels.table.ts's comment for
    // the full reasoning): a campaign in tenant B must not be able to
    // reference tenant A's segment or template even though those bare ids
    // really exist. ON DELETE RESTRICT — a sent campaign is the record of
    // what customers were told; deleting its template/segment must not be
    // possible.
    foreignKey({
      columns: [table.tenantId, table.segmentId],
      foreignColumns: [segments.tenantId, segments.id],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.templateId],
      foreignColumns: [messageTemplates.tenantId, messageTemplates.id],
    }).onDelete('restrict'),
  ],
).enableRLS();
