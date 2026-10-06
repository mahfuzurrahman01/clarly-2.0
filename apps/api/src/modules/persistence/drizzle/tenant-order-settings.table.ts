// F25 (Orders in Chat), D1.1: the per-tenant switch that decides whether the
// agent may place an order at all.
//
// Deliberately NOT a column on `tenant_policy`. `tenant_policy` is read on the
// hot respond path for every turn and its fields are prompt-facing (persona,
// forbidden topics, confidence threshold). Order settings are read only when
// `create_order` actually executes, and they carry an opt-in audit trail
// (`auto_enabled_by`, `auto_eligibility_snapshot`) that has no business being
// loaded into an `AgentTurnInput` or rendered near a prompt. Same shape as
// `tenant_policy` (tenant_id IS the primary key — a tenant has at most one),
// different lifecycle.
//
// MISSING ROW = 'disabled'. Nothing seeds this at signup; the default is
// absence. Fail closed, exactly like `withTenantTx()` does with a missing
// tenant id.
//
// RLS: same FORCE + NULLIF guard pattern as every other tenant table.
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

/**
 * Kept in lockstep with migration 0059's `tenant_order_settings_mode_check`.
 * The DB is the second barrier, this list is the first.
 *
 * - `disabled`  — the agent cannot place an order under any prompt. No
 *                 `tenant_tools` row exists, and the executor refuses even if
 *                 one goes stale.
 * - `human_approval` — the tool succeeds and writes a `pending_approval` row;
 *                 nothing reaches a store and nothing is confirmed to the
 *                 customer until a human approves it in the console.
 * - `auto`      — the order is written `confirmed` and the store push is
 *                 enqueued. Never granted automatically (D1.5).
 */
export const ORDER_MODES = ['disabled', 'human_approval', 'auto'] as const;
export type OrderMode = (typeof ORDER_MODES)[number];

/** The mode a tenant with no settings row is treated as having. */
export const DEFAULT_ORDER_MODE: OrderMode = 'disabled';

export const DEFAULT_APPROVAL_WINDOW_HOURS = 24;
export const MIN_APPROVAL_WINDOW_HOURS = 1;
export const MAX_APPROVAL_WINDOW_HOURS = 168;

export const tenantOrderSettings = pgTable('tenant_order_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull().default(DEFAULT_ORDER_MODE),
  /**
   * COD is the only phase-1 payment method (D3). Kept as a column rather than
   * assumed, so the console can show the merchant what their customers will be
   * offered — and so D1.5's auto-mode eligibility has something to check.
   */
  codEnabled: boolean('cod_enabled').notNull().default(true),
  /** A pending order older than this is swept to `expired` (D1.4). */
  approvalWindowHours: integer('approval_window_hours')
    .notNull()
    .default(DEFAULT_APPROVAL_WINDOW_HOURS),
  /** Audit trail for the auto-mode opt-in. Who, when, and against what evidence. */
  autoEnabledAt: timestamp('auto_enabled_at', { withTimezone: true }),
  autoEnabledBy: uuid('auto_enabled_by'),
  autoEligibilitySnapshot: jsonb('auto_eligibility_snapshot').$type<
    Record<string, unknown>
  >(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();
